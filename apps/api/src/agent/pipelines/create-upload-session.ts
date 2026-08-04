import { DbAgentSession } from "../../db/services/agent-session.ts";
import { DbDocument } from "../../db/services/document.ts";
import { CreateAgentSessionRequest } from "@shipwright/shared/schemas/api.js";
import { StorageAdapter } from "../../storage/index.ts";
import { Effect } from "effect";

export const createUploadSession = Effect.fn("agent/createUploadSession")(function* (payload: {
  userId: string;
  files: CreateAgentSessionRequest["files"];
}) {
  const agentSessionDb = yield* DbAgentSession;
  const documentDb = yield* DbDocument;
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

  return { sessionId: session.id, uploads };
});
