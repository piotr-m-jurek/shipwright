import {
  createChunks,
  getDocumentById,
  getDocumentsBySessionId,
  updateAgentSession,
  updateDocument,
  updateDocumentStatus,
} from "../db/queries.js";
import { type StorageAdapter } from "../storage/index.js";
import PQueue from "p-queue";
import { parseDocument } from "./parsers.js";
import { estimateTokenCount } from "./lib/estimate-token-count.js";
import { chunkDocument } from "./chunker.js";
import { embedChunks } from "./embedder.js";
import _ from "lodash";
import { ConfirmUploadRequest } from "../shared/schemas/sessions.js";

const jobQueue = new PQueue({ concurrency: 2 });

export async function processUploadedDocuments({
  uploads,
  sessionId,
  storageAdapter,
}: {
  uploads: ConfirmUploadRequest["uploads"];
  sessionId: string;
  storageAdapter: StorageAdapter;
}) {
  for (const upload of uploads) {
    const doc = await getDocumentById(upload.documentId).catch(() => {
      // NOTE: document not found errors are not reflected in session status aggregation
      console.error(
        `[${processUploadedDocuments.name}] Document not found. Document id: ${upload.documentId}`,
      );
      return null;
    });
    if (!doc) {
      continue;
    }

    jobQueue.add(async () => {
      try {
        await updateDocumentStatus(doc.id, "processing");

        const rawDocument = await storageAdapter.download(upload.s3Key);
        const parsed = await parseDocument(Buffer.from(rawDocument), doc.filename);
        const tokenCount = estimateTokenCount(parsed.text);
        const chunks = chunkDocument(parsed.text, parsed.type);
        const embeddings = await embedChunks(chunks);
        const zipped = _.zip(chunks, embeddings);
        await createChunks(
          zipped.map(([chunk, embedding], index) => ({
            sessionId,
            documentId: doc.id,
            documentType: doc.documentType,
            embedding: embedding || [], // TODO:
            chunkIndex: index,
            content: chunk ?? "", // TODO:
          })),
        );

        await updateDocument(doc.id, { tokenCount, status: "ready" });
      } catch (error) {
        console.error(error);
        await updateDocumentStatus(doc.id, "error");
      }
    });
  }

  await jobQueue.onIdle();

  const docs = await getDocumentsBySessionId(sessionId);
  if (docs.every((doc) => doc.status === "error")) {
    await updateAgentSession(sessionId, "error");
  } else if (docs.filter((doc) => doc.status === "error").length) {
    await updateAgentSession(sessionId, "partial_error");
  } else {
    await updateAgentSession(sessionId, "processing");
  }
}
