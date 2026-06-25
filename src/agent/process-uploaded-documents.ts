import { StorageAdapter } from "../storage/index.js";
import { parseDocument } from "./parsers.js";
import { estimateTokenCount } from "./estimate-token-count.js";
import { chunkDocument } from "./chunker.js";
import { embedChunks } from "./embedder.js";
import { Effect, Schema, Array, pipe } from "effect";
import { ConfirmUploadRequest } from "../shared/schemas/api.js";
import { SelectDocument } from "../shared/schemas/index.js";
import { DatabaseService } from "../db/queries.js";

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
  sessionId: string;
}) {
  const db = yield* DatabaseService;
  yield* Effect.forEach(
    uploads,
    (upload) =>
      Effect.gen(function* () {
        const doc = yield* db.getDocumentById(upload.documentId);
        yield* pipe(
          processDoc({ sessionId, doc, upload }),
          Effect.tapError(() => db.updateDocumentStatus(doc.id, "error")),
        );
      }),
    { concurrency: 2 },
  );

  // Aggregate session status based on document outcomes
  const docs = yield* db.getDocumentsBySessionId(sessionId);

  const allError = docs.every((doc) => doc.status === "error");
  const someError = docs.some((doc) => doc.status === "error");
  const status = allError ? "error" : someError ? "partial_error" : "processing";

  yield* db.updateAgentSession(sessionId, status);
});

const processDoc = ({
  doc,
  upload,
  sessionId,
}: {
  doc: SelectDocument;
  upload: ConfirmUploadRequest["uploads"][number];
  sessionId: string;
}) =>
  Effect.gen(function* () {
    const storage = yield* StorageAdapter;
    const db = yield* DatabaseService;
    yield* db.updateDocumentStatus(doc.id, "processing");

    const rawDocument = yield* storage.download(upload.s3Key);
    const parsed = yield* parseDocument(Buffer.from(rawDocument), doc.filename);
    const chunks = chunkDocument(parsed);
    const tokenCount = estimateTokenCount(parsed.text);

    const embeddings = yield* embedChunks(chunks.map((ch) => ch.content));
    const zipped = Array.zip(chunks, embeddings);

    yield* db.createChunks(
      zipped.map(([chunk, embedding], index) => ({
        sessionId,
        documentId: doc.id,
        documentType: doc.documentType,
        embedding: [...embedding],
        chunkIndex: index,
        content: chunk?.content ?? "",
        charOffset: chunk?.charOffset,
        pageNumber: chunk?.pageNumber,
        headingPath: chunk?.headingPath,
      })),
    );

    yield* db.updateDocument(doc.id, { tokenCount, status: "ready" });
  });
