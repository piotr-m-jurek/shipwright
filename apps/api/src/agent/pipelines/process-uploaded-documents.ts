import { StorageAdapter } from "../../storage/index.ts";
import { parseDocument } from "../parsers.ts";
import { estimateTokenCount } from "../lib/estimate-token-count.ts";
import { chunkDocument } from "../lib/chunker.ts";
import { Effect, Option, Schema, Array, pipe } from "effect";
import { DbAgentSession } from "../../db/services/agent-session.ts";
import { DbDocument } from "../../db/services/document.ts";
import { DbChunk } from "../../db/services/chunk.ts";
import { ConfirmUploadRequest } from "@shipwright/shared/schemas/api.js";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { EmbeddingService } from "../embedding-service.js";

// TODO: actually throw those errors, not DB errors
export class DocumentNotFoundError extends Schema.TaggedErrorClass<DocumentNotFoundError>()(
  "DocumentNotFoundError",
  { cause: Schema.Defect() },
) {}

export class UpdateDocumentStatusError extends Schema.TaggedErrorClass<UpdateDocumentStatusError>()(
  "UpdateDocumentStatusError",
  { cause: Schema.Defect() },
) {}

export class ProcessDocumentError extends Schema.TaggedErrorClass<ProcessDocumentError>()(
  "ProcessDocumentError",
  { cause: Schema.Defect() },
) {}

export const processUploadedDocuments = Effect.fn("agent/process-uploaded-documents")(function* ({
  uploads,
  sessionId,
}: {
  uploads: ConfirmUploadRequest["uploads"];
  sessionId: AgentSessionId;
}) {
  const storage = yield* StorageAdapter;
  const chunkerton = yield* EmbeddingService;
  const agentSessionDb = yield* DbAgentSession;
  const documentDb = yield* DbDocument;
  const chunkDb = yield* DbChunk;
  yield* Effect.forEach(
    uploads,
    (upload) =>
      Effect.gen(function* () {
        const doc = yield* documentDb.getDocumentById(upload.documentId).pipe(
          Effect.map(Option.getOrThrow),
        );

        const processDoc = Effect.gen(function* () {
          yield* documentDb.updateDocumentStatus(doc.id, "processing");

          const rawDocument = yield* storage.download(upload.s3Key);
          const parsed = yield* parseDocument(Buffer.from(rawDocument), doc.filename);
          const chunks = chunkDocument(parsed);
          const tokenCount = estimateTokenCount(parsed.text);

          const embeddings = yield* chunkerton.embedChunks(chunks.map((ch) => ch.content));
          const zipped = Array.zip(chunks, embeddings);

          yield* chunkDb.createChunks(
            zipped.map(([chunk, embedding], index) => ({
              sessionId,
              documentId: doc.id,
              embedding: [...embedding],
              chunkIndex: index,
              content: chunk?.content ?? "",
              charOffset: chunk?.charOffset,
              pageNumber: chunk?.pageNumber,
              headingPath: chunk?.headingPath,
            })),
          );

          yield* documentDb.updateDocument(doc.id, { tokenCount, status: "ready" });
        });

        yield* pipe(
          processDoc,
          Effect.tapError(() => documentDb.updateDocumentStatus(doc.id, "error")),
        );
      }),
    { concurrency: 2 },
  );

  const docs = yield* documentDb.getDocumentsBySessionId(sessionId);

  const allError = docs.every((doc) => doc.status === "error");
  const someError = docs.some((doc) => doc.status === "error");
  const status = allError ? "error" : someError ? "partial_error" : "processing";

  yield* agentSessionDb.updateAgentSession(sessionId, status);
});
