import { AgentSessionRepository } from "../../db/repositories/agent-session-repository";
import { DocumentRepository } from "../../db/repositories/document-repository";
import { CreateAgentSessionRequest } from "@shipwright/shared/schemas/api";
import type { UserId } from "@shipwright/shared/domain/ids";
import { StorageAdapter } from "../../storage/index";
import { Effect, Metric } from "effect";
import { sessionCreatedCounter } from "../../observability/metrics";

export const createUploadSession = Effect.fn("agent/createUploadSession")(function* (payload: {
  userId: UserId;
  files: CreateAgentSessionRequest["files"];
}) {
  yield* Effect.annotateCurrentSpan({
    "shipwright.user.id": payload.userId,
    "shipwright.upload.count": payload.files.length,
  });
  const agentSessionDb = yield* AgentSessionRepository;
  const documentDb = yield* DocumentRepository;
  const storage = yield* StorageAdapter;
  const session = yield* agentSessionDb.createAgentSession({
    status: "uploading",
    userId: payload.userId,
  });

  const uploads = yield* Effect.forEach(
    payload.files,
    (file) =>
      Effect.gen(function* () {
        const doc = yield* documentDb.createDocument({
          filename: file.filename,
          sessionId: session.id,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        });

        const s3Key = `${session.id}/${doc.id}`;
        const presignedUrl = yield* storage.generatePresignedUrl(s3Key, file.mimeType, 15);
        return { presignedUrl, s3Key, documentId: doc.id };
      }),
    { concurrency: "unbounded" },
  );

  yield* Metric.update(sessionCreatedCounter, 1);
  return { sessionId: session.id, uploads };
});
