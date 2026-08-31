/**
 * SSE questions stream — GET /api/sessions/:sessionId/questions/stream
 *
 * Streams live session status + questions as Server-Sent Events. Each event
 * is named "snapshot" and carries a `SessionQuestionsSnapshot` JSON payload.
 *
 * Auth: reads the better-auth session cookie directly (same as debug SSE —
 * HttpApiBuilder cannot produce streaming responses).
 */

import { Cause, Context, Effect, Option, Queue, Schedule, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Sse } from "effect/unstable/encoding";
import { AuthService } from "@shipwright/auth/auth-service";
import { extractSessionToken, sessionCookieHeader } from "@shipwright/shared/api/session-cookie";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { getOrRestoreActor } from "../../agent/session-actor";
import type { AgentSessionId, UserId } from "@shipwright/shared/domain/ids";
import type { SessionQuestionsSnapshot } from "@shipwright/shared/schemas/questions";

// ---------------------------------------------------------------------------
// Services type
// ---------------------------------------------------------------------------

type QuestionsServices = AgentSessionRepository | ClarificationRepository;

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
    const agentSessionDb = yield* AgentSessionRepository;
    const clarificationDb = yield* ClarificationRepository;

    const session = yield* agentSessionDb
      .getAgentSessionById({ sessionId })
      .pipe(Effect.orDie, Effect.flatMap(Effect.fromOption), Effect.orDie);

    const questions =
      session.status === "awaiting_answers"
        ? yield* clarificationDb.getQuestionsBySessionId(sessionId).pipe(Effect.orDie)
        : [];

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

      // --- Ownership check (404 for unknown or other user's session) ---
      const agentSessionDb = yield* AgentSessionRepository;
      const sessionOption = yield* agentSessionDb
        .getAgentSessionByIdForUser({ sessionId, userId: userId as UserId })
        .pipe(Effect.orDie);

      if (Option.isNone(sessionOption)) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }

      // --- Get or restore the XState actor ---
      const actor = yield* getOrRestoreActor(sessionId).pipe(Effect.orDie);

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
