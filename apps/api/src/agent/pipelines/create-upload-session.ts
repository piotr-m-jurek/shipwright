import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { CreateAgentSessionRequest } from "@shipwright/shared/schemas/api";
import { ServiceUnavailableError } from "@shipwright/shared/domain/errors";
import type { AgentSessionId, UserId } from "@shipwright/shared/domain/ids";
import { StorageAdapter } from "@shipwright/storage";
import { Effect, Metric } from "effect";
import { sessionCreatedCounter } from "../../observability/metrics";
import { Spans } from "@shipwright/observability";
import { AgentSessionAggregate } from "../agent-session-aggregate";

/**
 * Creates a document row + presigned upload URL per file, against an
 * ALREADY-EXISTING session. Shared by createUploadSession (a brand new
 * session, created just above the call site) and createUploadForExistingSession
 * (SHIP-179/180 — adding a document to an already-`complete` session) —
 * this is the part of the initial-upload flow that has nothing to do with
 * session creation itself.
 */
const createDocumentUploads = Effect.fn("agent/createDocumentUploads")(function* (
  sessionId: AgentSessionId,
  files: CreateAgentSessionRequest["files"],
) {
  const documentDb = yield* DocumentRepository;
  const storage = yield* StorageAdapter;

  return yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const doc = yield* documentDb.createDocument({
          filename: file.filename,
          sessionId,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        });

        const s3Key = `${sessionId}/${doc.id}`;
        const presignedUrl = yield* storage.generatePresignedUrl(s3Key, file.mimeType, 15);
        return { presignedUrl, s3Key, documentId: doc.id };
      }),
    { concurrency: "unbounded" },
  );
});

/**
 * Creates a brand-new AgentSession row, server-side ID (defaultRandom()).
 * Extracted as its own usecase — not inlined into createUploadSession below
 * — so it has a clean home to grow into later (e.g. a title-on-creation
 * feature) without dragging in upload-specific concerns.
 */
const createSession = Effect.fn("agent/createSession")(function* (userId: UserId) {
  const agentSessionDb = yield* AgentSessionRepository;
  const session = yield* agentSessionDb.createAgentSession({ status: "uploading", userId });
  yield* Metric.update(sessionCreatedCounter, 1);
  return session;
});

export const createUploadSession = Effect.fn("agent/createUploadSession")(function* (payload: {
  userId: UserId;
  files: CreateAgentSessionRequest["files"];
}) {
  yield* Effect.annotateCurrentSpan({
    ...Spans.user(payload.userId),
    ...Spans.uploadCount(payload.files.length),
  });

  const session = yield* createSession(payload.userId);
  const uploads = yield* createDocumentUploads(session.id, payload.files);

  return { sessionId: session.id, uploads };
});

/**
 * SHIP-179/180 — add a document to an already-existing session (idle,
 * uploading, or complete — see requireSessionAcceptsDocuments). Reuses
 * CreateAgentSessionRequest/CreateAgentSessionResponse verbatim (both are
 * already a `files: [...]`/`uploads: [...]` array shape — no reason a
 * single-document addition needs its own schema) and the same
 * createDocumentUploads helper createUploadSession uses above; the only
 * genuinely new step is the precondition check.
 *
 * SessionStateError (the precondition failing) is a real, distinct 409 and
 * passes through untouched; every other failure mode here (actor-store
 * lookup, document insert, presigned-URL generation) is a genuine infra
 * failure and gets normalized to ServiceUnavailableError, same SHIP-178
 * convention used across every other handler.
 */
const toServiceUnavailableError = () =>
  Effect.fail(new ServiceUnavailableError({ message: "A backing service is temporarily unavailable" }));

export const createUploadForExistingSession = Effect.fn("agent/createUploadForExistingSession")(
  function* (payload: {
    sessionId: AgentSessionId;
    userId: UserId;
    files: CreateAgentSessionRequest["files"];
  }) {
    yield* Effect.annotateCurrentSpan({
      ...Spans.session(payload.sessionId),
      ...Spans.user(payload.userId),
      ...Spans.uploadCount(payload.files.length),
    });

    const aggregate = yield* AgentSessionAggregate;
    yield* aggregate.requireSessionAcceptsDocuments(payload.sessionId).pipe(
      Effect.catchTags({
        "shipwright/agent/SessionNotFoundError": toServiceUnavailableError,
        EffectDrizzleQueryError: toServiceUnavailableError,
      }),
    );

    const uploads = yield* createDocumentUploads(payload.sessionId, payload.files).pipe(
      Effect.catchTags({
        EffectDrizzleQueryError: toServiceUnavailableError,
        "shipwright/storage/PresignedUrlError": toServiceUnavailableError,
      }),
    );
    return { sessionId: payload.sessionId, uploads };
  },
);
