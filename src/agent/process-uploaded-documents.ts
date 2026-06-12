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
import { chunkDocument } from "./chunker.js";
import { embedChunks } from "./embedder.js";
import { ConfirmUploadRequest } from "../shared/schemas/api.js";
import { Effect, Schema, Array } from "effect";

export namespace EffectProcessing {
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
    {
      cause: Schema.Defect(),
    },
  ) {}

  export const processUploadedDocuments = Effect.fn("agent/process-uploaded-documents")(function* ({
    uploads,
    sessionId,
  }: {
    uploads: ConfirmUploadRequest["uploads"];
    sessionId: string;
  }) {
    const storage = yield* StorageAdapter;

    yield* Effect.forEach(
      uploads,
      (upload) =>
        Effect.gen(function* () {
          const doc = yield* Effect.tryPromise({
            try: () => getDocumentById(upload.documentId),
            catch: (cause) => new DocumentNotFoundError({ cause }),
          });

          // doc is in scope here — wrap the processing pipeline so errors set doc status
          yield* Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => updateDocumentStatus(doc.id, "processing"),
              catch: (cause) => new UpdateDocumentStatusError({ cause }),
            });

            const rawDocument = yield* storage.download(upload.s3Key);
            const parsed = yield* parseDocument(Buffer.from(rawDocument), doc.filename);
            const chunks = chunkDocument(parsed);
            const tokenCount = estimateTokenCount(parsed.text);

            const embeddings = yield* embedChunks(chunks.map((ch) => ch.content));
            const zipped = Array.zip(chunks, embeddings);

            yield* Effect.tryPromise({
              try: () =>
                createChunks(
                  zipped.map(([chunk, embedding], index) => ({
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

            yield* Effect.tryPromise({
              try: () => updateDocument(doc.id, { tokenCount, status: "ready" }),
              catch: (cause) => new UpdateDocumentStatusError({ cause }),
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.tryPromise({
                try: () => updateDocumentStatus(doc.id, "error"), // doc is in scope here
                catch: (cause) => new UpdateDocumentStatusError({ cause }),
              }).pipe(Effect.andThen(Effect.fail(error))),
            ),
          );
        }),
      { concurrency: 2 },
    );

    // Aggregate session status based on document outcomes
    const docs = yield* Effect.tryPromise({
      try: () => getDocumentsBySessionId(sessionId),
      catch: (cause) => new ProcessDocumentError({ cause }),
    });

    const allError = docs.every((doc) => doc.status === "error");
    const someError = docs.some((doc) => doc.status === "error");

    yield* Effect.tryPromise({
      try: () =>
        updateAgentSession(
          sessionId,
          allError ? "error" : someError ? "partial_error" : "processing",
        ),
      catch: (cause) => new ProcessDocumentError({ cause }),
    });
  });
}
