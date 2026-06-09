import { createAgentSession, createDocument } from "../db/queries.js";
import { StorageAdapter } from "../storage/index.js";
import { CreateSessionRequest, CreateSessionResponse } from "../shared/schemas/sessions.js";

export async function createUploadSession({
  files,
  storageAdapter,
}: {
  files: CreateSessionRequest["files"];
  storageAdapter: StorageAdapter;
}): Promise<CreateSessionResponse> {
  const session = await createAgentSession({ status: "uploading" });

  const uploads = await Promise.all(
    files.map(async (file) => {
      const doc = await createDocument({
        filename: file.filename,
        documentType: file.documentType,
        sessionId: session.id,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      });
      const s3Key = `${session.id}/${doc.id}`;
      const presignedUrl = await storageAdapter.generatePresignedUrl(s3Key, file.mimeType, 15);

      return { presignedUrl, s3Key, documentId: doc.id };
    }),
  );

  return { sessionId: session.id, uploads };
}
