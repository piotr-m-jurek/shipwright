import { DatabaseService } from "../db/queries.js";
import { CreateAgentSessionRequest } from "@shipwright/shared/schemas/api.js";
import { StorageAdapter } from "../storage/index.js";
import { Effect } from "effect";

export const createUploadSession = Effect.fn("agent/createUploadSession")(function* (
  files: CreateAgentSessionRequest["files"],
) {
  const dbService = yield* DatabaseService;
  const storage = yield* StorageAdapter;
  const session = yield* dbService.createAgentSession({ status: "uploading" });

  const uploads = yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const doc = yield* dbService.createDocument({
          filename: file.filename,
          documentType: file.documentType,
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

  return { sessionId: session.id, uploads };
});
