import { createAgentSession, createDocument } from "../db/queries.js";
import { EffectStorageAdapterService } from "../storage/index.js";
import { CreateSessionRequest } from "../shared/schemas/sessions.js";
import { Effect } from "effect";

export const createUploadSession = Effect.fn("agent/createUploadSession")(function* (
  files: CreateSessionRequest["files"],
) {
  const storage = yield* EffectStorageAdapterService.EffectStorageAdapter;
  const session = yield* Effect.promise(() => createAgentSession({ status: "uploading" }));

  const uploads = yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const doc = yield* Effect.promise(() =>
          createDocument({
            filename: file.filename,
            documentType: file.documentType,
            sessionId: session.id,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
          }),
        );

        const s3Key = `${session.id}/${doc.id}`;
        const presignedUrl = yield* storage.generatePresignedUrl(s3Key, file.mimeType, 15);
        return { presignedUrl, s3Key, documentId: doc.id };
      }),
    { concurrency: "unbounded" },
  );

  return { sessionId: session.id, uploads };
});
