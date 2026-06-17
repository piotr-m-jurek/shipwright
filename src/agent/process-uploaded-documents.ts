import {
  createChunks,
  getDocumentById,
  getDocumentsBySessionId,
  updateAgentSession,
  updateDocument,
  updateDocumentStatus,
} from "../db/queries.js";
import { StorageAdapter } from "../storage/index.js";
import { parseDocument } from "./parsers.js";
import { estimateTokenCount } from "./estimate-token-count.js";
import { chunkDocument, ChunkResult } from "./chunker.js";
import { embedChunks } from "./embedder.js";
import { Effect, Schema, Array, pipe } from "effect";
import { ConfirmUploadRequest } from "../shared/schemas/api.js";
import { SelectAgentSession, SelectDocument } from "../shared/schemas/index.js";
import { Embedding } from "ai";

class DocumentNotFoundError extends Schema.TaggedErrorClass<DocumentNotFoundError>()(
  "DocumentNotFoundError",
  { cause: Schema.Defect() },
) {}

class UpdateDocumentStatusError extends Schema.TaggedErrorClass<UpdateDocumentStatusError>()(
  "UpdateDocumentStatusError",
  { cause: Schema.Defect() },
) {}

class ProcessDocumentError extends Schema.TaggedErrorClass<ProcessDocumentError>()(
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
  yield* Effect.forEach(
    uploads,
    (upload) =>
      Effect.gen(function* () {
        const doc = yield* getDoc(upload.documentId);
        yield* pipe(
          processDoc({ sessionId, doc, upload }),
          Effect.tapError(() => updateDocStatus(doc.id, "error")),
        );
      }),
    { concurrency: 2 },
  );

  // Aggregate session status based on document outcomes
  const docs = yield* getDocsBySeshId(sessionId);

  const allError = docs.every((doc) => doc.status === "error");
  const someError = docs.some((doc) => doc.status === "error");
  const status = allError ? "error" : someError ? "partial_error" : "processing";

  yield* updateAgentSesh(sessionId, status);
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
    yield* updateDocStatus(doc.id, "processing");

    const rawDocument = yield* storage.download(upload.s3Key);
    const parsed = yield* parseDocument(Buffer.from(rawDocument), doc.filename);
    const chunks = chunkDocument(parsed);
    const tokenCount = estimateTokenCount(parsed.text);

    const embeddings = yield* embedChunks(chunks.map((ch) => ch.content));
    const zipped = Array.zip(chunks, embeddings);

    yield* writeChunkers({ chunkyEmbeddings: zipped, sessionId, doc });
    yield* updateDoc(doc.id, { tokenCount, status: "ready" });
  });

const writeChunkers = ({
  doc,
  sessionId,
  chunkyEmbeddings,
}: {
  doc: SelectDocument;
  sessionId: string;
  chunkyEmbeddings: [ChunkResult, Embedding][];
}) =>
  Effect.tryPromise({
    try: () =>
      createChunks(
        chunkyEmbeddings.map(([chunk, embedding], index) => ({
          sessionId,
          documentId: doc.id,
          documentType: doc.documentType,
          embedding: embedding || [],
          chunkIndex: index,
          content: chunk?.content ?? "",
          charOffset: chunk?.charOffset,
          pageNumber: chunk?.pageNumber,
          headingPath: chunk?.headingPath,
        })),
      ),
    catch: (cause) => new ProcessDocumentError({ cause }),
  });

const updateAgentSesh = (sessionId: string, status: SelectAgentSession["status"]) =>
  Effect.tryPromise({
    try: () => updateAgentSession(sessionId, status),
    catch: (cause) => new ProcessDocumentError({ cause }),
  });
const updateDocStatus = (docId: string, status: SelectDocument["status"]) =>
  Effect.tryPromise({
    try: () => updateDocumentStatus(docId, status),
    catch: (cause) => new UpdateDocumentStatusError({ cause }),
  });

const getDoc = (docId: string) =>
  Effect.tryPromise({
    try: () => getDocumentById(docId),
    catch: (cause) => new DocumentNotFoundError({ cause }),
  });

const getDocsBySeshId = (sessionId: string) =>
  Effect.tryPromise({
    try: () => getDocumentsBySessionId(sessionId),
    catch: (cause) => new ProcessDocumentError({ cause }),
  });

const updateDoc = (docId: string, payload: Pick<SelectDocument, "status" | "tokenCount">) =>
  Effect.tryPromise({
    try: () => updateDocument(docId, payload),
    catch: (cause) => new UpdateDocumentStatusError({ cause }),
  });
