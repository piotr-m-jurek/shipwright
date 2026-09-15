/**
 * SSE questions stream — GET /api/sessions/:sessionId/questions/stream
 *
 * Streams live session status + questions as Server-Sent Events. Each event
 * is named "snapshot" and carries a `SessionQuestionsSnapshot` JSON payload.
 *
 * Auth: reads the better-auth session cookie directly (same as debug SSE —
 * HttpApiBuilder cannot produce streaming responses).
 */

import { Cause, Context, Effect, Exit, Option, Queue, Schedule, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Sse } from "effect/unstable/encoding";
import { AuthService } from "@shipwright/auth/auth-service";
import { extractSessionToken, sessionCookieHeader } from "@shipwright/shared/api/session-cookie";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { AgentSessionSnapshotReader } from "@shipwright/db/repositories/agent-session-snapshot-reader";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { getOrRestoreActor } from "../../agent/session-actor";
import type { AgentSessionId, UserId } from "@shipwright/shared/domain/ids";
import type { SessionQuestionsSnapshot } from "@shipwright/shared/schemas/questions";

// ---------------------------------------------------------------------------
// Services type
// ---------------------------------------------------------------------------

type QuestionsServices = AgentSessionRepository | AgentSessionSnapshotReader | ClarificationRepository;

// ---------------------------------------------------------------------------
// Auth helper (same as debug SSE)
// ---------------------------------------------------------------------------

const resolveUserId = (
  cookieHeader: string | undefined,
): Effect.Effect<string | null, never, AuthService> =>
  Effect.gen(function* () {
    const token = extractSessionToken(cookieHeader);
    if (Option.isNone(token)) return null;

    const authService = yield* AuthService;
    const session = yield* authService
      .getSession({ headers: sessionCookieHeader(token.value) })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return session?.user.id ?? null;
  });

// ---------------------------------------------------------------------------
// Build questions payload from the DB
// ---------------------------------------------------------------------------

const buildQuestionsPayload = (
  sessionId: AgentSessionId,
): Effect.Effect<SessionQuestionsSnapshot, never, QuestionsServices> =>
  Effect.gen(function* () {
    // getUnsafe (not the ownership-checked `get`) is safe here — the route
    // handler below already runs getAgentSessionByIdForUser earlier in the
    // same request, which is exactly getUnsafe's documented precondition
    // (see agent-session-snapshot-reader.ts's doc comment; buildDebugPayload
    // in session-debug-sse.ts is the same sanctioned pattern). Needed for
    // xstateSnapshot.documents, which plain AgentSessionRepository reads
    // deliberately exclude.
    const snapshotReader = yield* AgentSessionSnapshotReader;
    const clarificationDb = yield* ClarificationRepository;

    const session = yield* snapshotReader
      .getUnsafe({ sessionId })
      .pipe(Effect.orDie, Effect.flatMap(Effect.fromOption), Effect.orDie);

    const questions =
      session.status === "awaiting_answers"
        ? yield* clarificationDb.getQuestionsBySessionId(sessionId).pipe(Effect.orDie)
        : [];

    // xstateSnapshot's declared type (MachineContext | null) doesn't match
    // what's actually persisted: the DB column holds the full XState actor
    // snapshot ({context, value, status, children, historyValue}), not
    // MachineContext flattened — confirmed against real data, and
    // restoreAgentActor's own code already treats it this way
    // (`snapshot as { context?: unknown }`, machine.ts). session-debug-sse.ts
    // and session-compute.ts's getSessionDebug read the same field without
    // this `.context` unwrap — a real, separate pre-existing bug, filed as
    // SHIP-192, not fixed here.
    const rawSnapshot = session.xstateSnapshot as unknown as {
      context?: { documents?: ReadonlyArray<{ readonly status: string }> };
    } | null;
    const documents = rawSnapshot?.context?.documents;

    return {
      status: session.status,
      inputMode: session.inputMode,
      errorReason: session.errorReason ?? null,
      questions: questions.map((q) => ({
        id: q.id,
        text: q.text,
        rationale: q.rationale,
        sourceDocuments: q.sourceDocuments,
        orderIndex: q.orderIndex,
      })),
      updatedAt: session.updatedAt.toISOString(),
      progress: documents
        ? {
            documentsSummarized: documents.filter((d) => d.status === "done").length,
            documentsTotal: documents.length,
          }
        : null,
    } satisfies SessionQuestionsSnapshot;
  });

// Offer a snapshot event to the queue — fire-and-forget from sync context
function emitSnapshot(
  sessionId: AgentSessionId,
  services: Context.Context<QuestionsServices>,
  queue: Queue.Queue<Uint8Array, Cause.Done>,
  encoder: TextEncoder,
): void {
  Effect.runForkWith(services)(
    buildQuestionsPayload(sessionId).pipe(
      Effect.map((payload) => {
        const sseText = Sse.encoder.write({
          _tag: "Event",
          event: "snapshot",
          id: undefined,
          data: JSON.stringify(payload),
        });
        Queue.offerUnsafe(queue, encoder.encode(sseText));
      }),
      Effect.ignore,
    ),
  );
}

// ---------------------------------------------------------------------------
// SSE route layer
// ---------------------------------------------------------------------------

export const SessionQuestionsSseLayer = HttpRouter.add(
  "GET",
  "/api/sessions/:sessionId/questions/stream",
  (req) =>
    Effect.gen(function* () {
      // --- Auth ---
      const cookieHeader = req.headers["cookie"] as string | undefined;
      yield* Effect.logDebug("[questions-sse] cookie header", {
        cookie: cookieHeader?.slice(0, 60),
      });
      const userId = yield* resolveUserId(cookieHeader);
      yield* Effect.logDebug("[questions-sse] resolved userId", { userId });

      if (!userId) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }

      // --- Parse sessionId from URL path ---
      const match = req.url.match(/\/api\/sessions\/([^/?]+)\/questions\/stream/);
      const sessionId = match?.[1] as AgentSessionId | undefined;

      if (!sessionId) {
        return HttpServerResponse.text("Bad Request", { status: 400 });
      }

      // --- Ownership check (404 for unknown or other user's session, 503
      //     if the store itself failed — SHIP-178: distinguish a real infra
      //     failure from "not found" instead of dying into a generic 500) ---
      const agentSessionDb = yield* AgentSessionRepository;
      const sessionExit = yield* agentSessionDb
        .getAgentSessionByIdForUser({ sessionId, userId: userId as UserId })
        .pipe(Effect.exit);

      if (Exit.isFailure(sessionExit)) {
        yield* Effect.logError("[questions-sse] ownership check failed", sessionExit.cause);
        return HttpServerResponse.text("Service Unavailable", { status: 503 });
      }
      if (Option.isNone(sessionExit.value)) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }

      // --- Get or restore the XState actor ---
      const actorExit = yield* Effect.exit(getOrRestoreActor(sessionId));
      if (Exit.isFailure(actorExit)) {
        yield* Effect.logError("[questions-sse] actor restore failed", actorExit.cause);
        return HttpServerResponse.text("Service Unavailable", { status: 503 });
      }
      const actor = actorExit.value;

      // --- Capture services for use from the subscription callback ---
      const services = yield* Effect.context<QuestionsServices>();
      const encoder = new TextEncoder();

      // --- Build SSE stream: XState actor transitions + 3s poll ---
      const actorStream: Stream.Stream<Uint8Array> = Stream.callback<Uint8Array>(
        (queue) =>
          Effect.gen(function* () {
            // Flush the connection immediately
            Queue.offerUnsafe(queue, encoder.encode(": ping\n\n"));

            // Initial snapshot on connect
            emitSnapshot(sessionId, services, queue, encoder);

            // Subscribe to future XState transitions
            const subscription = actor.subscribe(() => {
              emitSnapshot(sessionId, services, queue, encoder);
            });

            yield* Effect.addFinalizer(() => Effect.sync(() => subscription.unsubscribe()));
          }),
        { bufferSize: 64, strategy: "sliding" },
      );

      // Periodic poll every 3s to catch external DB changes
      const pollEffect = buildQuestionsPayload(sessionId).pipe(
        Effect.provideContext(services),
        Effect.map((payload) => {
          const sseText = Sse.encoder.write({
            _tag: "Event",
            event: "snapshot",
            id: undefined,
            data: JSON.stringify(payload),
          });
          return encoder.encode(sseText);
        }),
      );

      const pollStream: Stream.Stream<Uint8Array> = Stream.fromEffect(pollEffect).pipe(
        Stream.repeat(Schedule.fixed("3 seconds")),
      );

      const snapshotStream = Stream.merge(actorStream, pollStream);

      return HttpServerResponse.stream(snapshotStream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }),
);
