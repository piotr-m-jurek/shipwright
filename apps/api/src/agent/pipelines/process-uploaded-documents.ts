import { StorageAdapter } from "../../storage/index.ts";
import { parseDocument } from "../parsers.ts";
import { estimateTokenCount } from "../lib/estimate-token-count.ts";
import { chunkDocument } from "../lib/chunker.ts";
import { Effect, Option, Schema, Array, pipe } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { AgentSessionRepository } from "../../db/repositories/agent-session-repository.ts";
import { DocumentRepository } from "../../db/repositories/document-repository.ts";
import { ChunkRepository } from "../../db/repositories/chunk-repository.ts";
import { ConfirmUploadRequest } from "@shipwright/shared/schemas/api.js";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { ChunkIndex } from "@shipwright/shared/domain/value-objects";
import { EmbeddingService } from "../embedding-service.js";
import { MessageQueue } from "../../queue/index.ts";

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
  yield* Effect.annotateCurrentSpan({
    "shipwright.session.id": sessionId,
    "shipwright.upload.count": uploads.length,
  });
  yield* Effect.logInfo(`[processUploadedDocuments] starting — ${uploads.length} document(s)`).pipe(
    Effect.annotateLogs({ sessionId, uploadCount: uploads.length }),
  );

  const storage = yield* StorageAdapter;
  const chunkerton = yield* EmbeddingService;
  const sql = yield* SqlClient;
  const agentSessionDb = yield* AgentSessionRepository;
  const documentDb = yield* DocumentRepository;
  const chunkDb = yield* ChunkRepository;
  yield* Effect.forEach(
    uploads,
    (upload) =>
      Effect.gen(function* () {
        const doc = yield* documentDb
          .getDocumentById(upload.documentId)
          .pipe(Effect.map(Option.getOrThrow));

        const processDoc = Effect.gen(function* () {
          yield* documentDb.updateDocumentStatus(doc.id, "processing");

          const rawDocument = yield* storage.download(upload.s3Key);
          const parsed = yield* parseDocument(Buffer.from(rawDocument), doc.filename);
          const chunks = chunkDocument(parsed);
          const tokenCount = estimateTokenCount(parsed.text);

          yield* Effect.logInfo(
            `[processUploadedDocuments] ${doc.filename}: ${chunks.length} chunks, ${tokenCount} tokens`,
          ).pipe(
            Effect.annotateLogs({
              documentId: doc.id,
              sessionId,
              chunkCount: chunks.length,
              tokenCount,
            }),
          );
          yield* Effect.annotateCurrentSpan({
            "shipwright.chunk.count": chunks.length,
            "shipwright.document.token_count": tokenCount,
          });

          const embeddings = yield* chunkerton.embedChunks(chunks.map((ch) => ch.content));
          const zipped = Array.zip(chunks, embeddings);

          yield* pipe(
            Effect.gen(function* () {
              yield* chunkDb.createChunks(
                zipped.map(([chunk, embedding], index) => ({
                  sessionId,
                  documentId: doc.id,
                  embedding: [...embedding],
                  chunkIndex: ChunkIndex.make(index),
                  content: chunk?.content ?? "",
                  charOffset: chunk?.charOffset,
                  pageNumber: Option.getOrNull(chunk.pageNumber),
                  headingPath: Option.getOrNull(chunk.headingPath),
                })),
              );
              yield* documentDb.updateDocument(doc.id, { tokenCount, status: "ready" });
            }),
            sql.withTransaction,
          );
        });

        yield* pipe(
          processDoc,
          Effect.tapCause((cause) =>
            Effect.logError(`[process-uploaded-documents] document failed: ${doc.filename}`).pipe(
              Effect.annotateLogs({ documentId: doc.id, sessionId }),
              Effect.andThen(Effect.logError(cause)),
            ),
          ),
          Effect.tapError(() => documentDb.updateDocumentStatus(doc.id, "error")),
          Effect.withSpan("agent/process-document", {
            attributes: {
              "shipwright.document.id": doc.id,
              "shipwright.document.filename": doc.filename,
              "shipwright.session.id": sessionId,
            },
          }),
        );
      }),
    { concurrency: 2 },
  );

  const docs = yield* documentDb.getDocumentsBySessionId(sessionId);

  const allError = docs.every((doc) => doc.status === "error");
  const someError = docs.some((doc) => doc.status === "error");
  const status = allError ? "error" : someError ? "partial_error" : "processing";

  yield* Effect.logInfo(`[processUploadedDocuments] finalising — status: ${status}`).pipe(
    Effect.annotateLogs({ sessionId, status, docCount: docs.length }),
  );
  yield* Effect.annotateCurrentSpan({ "shipwright.session.final_status": status });
  yield* agentSessionDb.updateAgentSession(sessionId, status);

  // Only kick off the workflow if at least some documents processed successfully.
  // If all failed, there are no chunks to summarise — the session stays in error.
  if (!allError) {
    const mq = yield* MessageQueue;
    yield* mq.publish("session.workflow", { sessionId }, { maxAttempts: 5 });
    yield* Effect.logInfo("[processUploadedDocuments] published session.workflow").pipe(
      Effect.annotateLogs({ sessionId }),
    );
  }
});
