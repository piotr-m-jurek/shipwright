import { Array, Effect, Schema, Result, pipe } from "effect";
import type { AgentSessionId, UserId } from "@shipwright/shared/domain/ids";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { MessageQueue } from "@shipwright/queue";

// ── Reason errors ─────────────────────────────────────────────────────────────

export class SessionNotFoundReason extends Schema.TaggedErrorClass<SessionNotFoundReason>()(
  "SessionNotFoundReason",
  {},
) {}

export class NotInErrorStateReason extends Schema.TaggedErrorClass<NotInErrorStateReason>()(
  "NotInErrorStateReason",
  { currentStatus: Schema.String },
) {}

export class NoDocumentsReason extends Schema.TaggedErrorClass<NoDocumentsReason>()(
  "NoDocumentsReason",
  {},
) {}

export class RetrySessionError extends Schema.TaggedErrorClass<RetrySessionError>()(
  "shipwright/agent/RetrySessionError",
  {
    reason: Schema.Union([SessionNotFoundReason, NotInErrorStateReason, NoDocumentsReason]),
  },
) {}

// ── Pipeline ──────────────────────────────────────────────────────────────────

/**
 * Retry a session stuck in `error` state due to a transient failure
 * (e.g. embedding service unavailable).
 *
 * Steps:
 * 1. Verify the session belongs to the requesting user and is in `error` state.
 * 2. Reset status to `uploading` (documents uploaded, awaiting processing)
 *    and clear `errorReason`.
 * 3. Re-publish `documents.process` with the session's existing S3 keys.
 *    The documents are already in S3 — no re-upload required.
 */
export const retrySession = Effect.fn("agent/retrySession")(function* (
  sessionId: AgentSessionId,
  userId: UserId,
) {
  const agentSessionDb = yield* AgentSessionRepository;
  const documentDb = yield* DocumentRepository;
  const mq = yield* MessageQueue;

  // Ownership check — yield Option directly via Effect.fromOption;
  // NoSuchElementError is caught and mapped to the typed reason
  const session = yield* agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId }).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.catchTag(
      "NoSuchElementError",
      () => new RetrySessionError({ reason: new SessionNotFoundReason() }),
    ),
  );

  // State check
  if (session.status !== "error" && session.status !== "partial_error") {
    return yield* new RetrySessionError({
      reason: new NotInErrorStateReason({ currentStatus: session.status }),
    });
  }

  // Rebuild uploads from documents already in storage
  const docs = yield* documentDb.getDocumentsBySessionId(sessionId);

  const uploads = yield* pipe(
    docs,
    Array.filterMap((d) =>
      pipe(
        Result.fromNullishOr(d.storagePath, () => "missing"),
        Result.map((s3Key) => ({ s3Key, documentId: d.id })),
      ),
    ),
    Array.match({
      onEmpty: () => new RetrySessionError({ reason: new NoDocumentsReason() }),
      onNonEmpty: Effect.succeed,
    }),
  );

  // Reset to uploading — documents are in S3, awaiting (re)processing; clear errorReason
  yield* agentSessionDb.updateAgentSession(sessionId, "uploading", null);

  // Re-enqueue
  yield* mq.publish("documents.process", { sessionId, uploads });

  yield* Effect.logInfo("[retrySession] re-enqueued documents.process").pipe(
    Effect.annotateLogs({ sessionId, documentCount: uploads.length }),
  );
});
