/**
 * SSE debug stream — GET /api/sessions/:sessionId/debug/stream
 *
 * Streams live XState snapshot updates for a session as Server-Sent Events.
 * Each event is named "snapshot" and carries the full debug JSON payload
 * matching the shape of the REST GET /debug endpoint.
 *
 * Auth: reads the better-auth session cookie directly (same check as
 * AuthorizationLayer, but in a raw HttpRouter handler so we can return a
 * streaming response — HttpApiBuilder cannot stream).
 */

import { Cause, Context, Effect, Option, Queue, Schedule, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { Sse } from "effect/unstable/encoding";
import { auth } from "@shipwright/auth/auth";
import { extractSessionToken, sessionCookieHeader } from "@shipwright/shared/api/session-cookie";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { DB } from "@shipwright/db";
import { queueMessages } from "../../queue/index";
import { sql } from "drizzle-orm";
import { getOrRestoreActor } from "../../agent/session-actor";
import type { AgentSessionId, UserId } from "@shipwright/shared/domain/ids";
import type { DebugSnapshot } from "@shipwright/shared/schemas/debug";

// ---------------------------------------------------------------------------
// Services type used by buildDebugPayload
// ---------------------------------------------------------------------------

type DebugServices =
  | AgentSessionRepository
  | DocumentRepository
  | ClarificationRepository
  | OutputRepository
  | DB;

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function resolveUserId(cookieHeader: string | undefined): Promise<string | null> {
  const token = extractSessionToken(cookieHeader);
  if (Option.isNone(token)) return null;

  try {
    const session = await auth.api.getSession({ headers: sessionCookieHeader(token.value) });
    return session?.user.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build the full debug payload from the DB (same logic as the REST handler)
// ---------------------------------------------------------------------------

const buildDebugPayload = (
  sessionId: AgentSessionId,
): Effect.Effect<DebugSnapshot, never, DebugServices> =>
  Effect.gen(function* () {
    const agentSessionDb = yield* AgentSessionRepository;
    const documentDb = yield* DocumentRepository;
    const clarificationDb = yield* ClarificationRepository;
    const outputDb = yield* OutputRepository;
    const db = yield* DB;

    const session = yield* agentSessionDb
      .getAgentSessionById({ sessionId })
      .pipe(Effect.orDie, Effect.flatMap(Effect.fromOption), Effect.orDie);

    const queueRows = yield* db
      .select({
        queue: queueMessages.queue,
        status: queueMessages.status,
        attempts: queueMessages.attempts,
        maxAttempts: queueMessages.maxAttempts,
        createdAt: queueMessages.createdAt,
      })
      .from(queueMessages)
      .where(sql`${queueMessages.payload}->>'sessionId' = ${sessionId}`)
      .orderBy(queueMessages.createdAt)
      .pipe(Effect.orDie);

    const documents = yield* documentDb.getDocumentsBySessionId(sessionId).pipe(Effect.orDie);
    const questions = yield* clarificationDb.getQuestionsBySessionId(sessionId).pipe(Effect.orDie);
    const answers = yield* clarificationDb.getAnswersBySessionId(sessionId).pipe(Effect.orDie);
    const outputs = yield* outputDb.getOutputsBySessionId(sessionId).pipe(Effect.orDie);

    const xstate = Option.match(Option.fromNullishOr(session.xstateSnapshot), {
      onNone: () => null,
      onSome: (snap) => ({
        value: String(session.status),
        round: snap.round ?? 0,
        inputMode: snap.inputMode ?? "context",
        outputVersion: snap.outputVersion ?? 1,
        documentSummaryCount: snap.documentSummaries?.length ?? 0,
        questionCount: snap.questions?.length ?? 0,
        answerCount: snap.answers?.length ?? 0,
        revisionFeedback: snap.revisionFeedback ? Option.getOrNull(snap.revisionFeedback) : null,
        raw: snap,
      }),
    });

    return {
      session: {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
      xstate,
      queue: queueRows.map((r) => ({
        queue: r.queue,
        status: r.status,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        createdAt: r.createdAt.toISOString(),
      })),
      documents: documents.map((d) => ({
        id: d.id,
        filename: d.filename,
        status: d.status,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        tokenCount: d.tokenCount ?? null,
      })),
      questions: questions.map((q) => ({
        id: q.id,
        text: q.text,
        orderIndex: q.orderIndex,
      })),
      answers: answers.map((a) => ({
        questionId: a.questionId,
        text: a.text,
        round: a.round,
      })),
      outputs: outputs.map((o) => ({
        type: o.type,
        version: o.version ?? null,
        createdAt: o.createdAt.toISOString(),
        contentLength: o.content?.length ?? 0,
      })),
    } satisfies DebugSnapshot;
  });

// Offer a snapshot event to the queue — fire-and-forget from sync context
function emitSnapshot(
  sessionId: AgentSessionId,
  services: Context.Context<DebugServices>,
  queue: Queue.Queue<Uint8Array, Cause.Done>,
  encoder: TextEncoder,
): void {
  Effect.runForkWith(services)(
    buildDebugPayload(sessionId).pipe(
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

export const SessionDebugSseLayer = HttpRouter.add(
  "GET",
  "/api/sessions/:sessionId/debug/stream",
  (req) =>
    Effect.gen(function* () {
      // --- Auth ---
      const cookieHeader = req.headers["cookie"] as string | undefined;
      yield* Effect.logDebug("[debug-sse] cookie header", { cookie: cookieHeader?.slice(0, 60) });
      const userId = yield* Effect.promise(() => resolveUserId(cookieHeader));
      yield* Effect.logDebug("[debug-sse] resolved userId", { userId });

      if (!userId) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }

      // --- Parse sessionId from URL path ---
      const match = req.url.match(/\/api\/sessions\/([^/?]+)\/debug\/stream/);
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

      // --- Capture services so we can run effects from the subscription callback ---
      const services = yield* Effect.context<DebugServices>();
      const encoder = new TextEncoder();

      // --- Build an SSE stream backed by the actor's subscription + periodic poll ---
      //
      // Two sources merged:
      // 1. XState actor.subscribe() — fires immediately on every state transition.
      // 2. Stream.repeat every 3s — ensures the view stays current even when
      //    no transitions occur (e.g. stuck sessions, external DB changes).
      //
      // Both sources do a full DB re-fetch so the snapshot always reflects
      // committed DB state (not just the in-memory XState snapshot).

      const actorStream: Stream.Stream<Uint8Array> = Stream.callback<Uint8Array>(
        (queue) =>
          Effect.gen(function* () {
            // Emit a ": ping" comment immediately so the proxy flushes the connection.
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

      // Periodic poll — re-fetch and emit every 3s regardless of XState transitions
      const pollEffect = buildDebugPayload(sessionId).pipe(
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
