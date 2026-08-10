import { StorageAdapter } from "../../storage/index";
import { parseDocument, verifyFileMimeType } from "../parsers";
import { estimateTokenCount } from "../lib/estimate-token-count";
import { chunkDocument } from "../lib/chunker";
import { Effect, Exit, Metric, Option, Schema, Array, pipe } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { AgentSessionRepository } from "../../db/repositories/agent-session-repository";
import { DocumentRepository } from "../../db/repositories/document-repository";
import { ChunkRepository } from "../../db/repositories/chunk-repository";
import { getOrRestoreActor } from "../session-actor";
import { MessageQueue } from "../../queue/index";
import { ConfirmUploadRequest } from "@shipwright/shared/schemas/api";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { ChunkIndex } from "@shipwright/shared/domain/value-objects";
import { EmbeddingService, EmbeddingError } from "../embedding-service";
import { documentParseErrorCounter } from "../../observability/metrics";

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

  // ── Embedding service health probe ──────────────────────────────────────
  // A trivial embed call before touching any documents. If TEI is down we
  // set the session to error immediately and ack the message (no retry) so
  // we don't burn all attempts in milliseconds and dead-letter silently.
  const probeResult = yield* Effect.exit(chunkerton.embedText("health"));
  if (Exit.isFailure(probeResult)) {
    yield* Effect.logError("[processUploadedDocuments] embedding service unavailable — aborting").pipe(
      Effect.annotateLogs({ sessionId }),
    );
    yield* agentSessionDb.updateAgentSession(sessionId, "error", "embedding_unavailable");
    return;
  }

  yield* Effect.forEach(
    uploads,
    (upload) =>
      Effect.gen(function* () {
        const doc = yield* documentDb
          .getDocumentById(upload.documentId)
          .pipe(Effect.map(Option.getOrThrow));

        const processDoc = Effect.gen(function* () {
          yield* documentDb.updateDocumentStatus(doc.id, "processing");

          yield* verifyFileMimeType(upload.s3Key, doc.filename);
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
                  content: chunk.content,
                  charOffset: chunk.charOffset,
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
          Effect.tapError((e) =>
            Effect.all([
              documentDb.updateDocumentStatus(doc.id, "error"),
              Metric.update(documentParseErrorCounter, 1),
              // If embedding failed mid-document, record the reason on the session
              e instanceof EmbeddingError
                ? agentSessionDb.updateAgentSession(sessionId, "error", "embedding_unavailable")
                : Effect.void,
            ]),
          ),
          Effect.withSpan("agent/process-document", {
            attributes: {
              "shipwright.document.id": doc.id,
              "shipwright.document.filename": doc.filename,
              "shipwright.session.id": sessionId,
            },
          }),
          // Swallow per-document errors so forEach continues with remaining
          // documents. The error is already recorded on the document row above.
          Effect.ignore,
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

  // Fire DOCUMENTS_READY so the machine can advance regardless of whether
  // USER_CONFIRM arrived before or after document processing completed.
  // If USER_CONFIRM already arrived (waiting_for_documents), the machine
  // transitions to summarizing here and we publish session.workflow.
  yield* getOrRestoreActor(sessionId).pipe(
    Effect.flatMap((actor) =>
      Effect.gen(function* () {
        actor.send({ type: "DOCUMENTS_READY" });

        // If machine is now in summarizing, USER_CONFIRM arrived early —
        // publish the workflow job that confirmAnalysis would have published.
        const afterState = actor.getSnapshot().value;
        if (afterState === "summarizing") {
          yield* Effect.logInfo("[processUploadedDocuments] DOCUMENTS_READY → summarizing, publishing session.workflow").pipe(
            Effect.annotateLogs({ sessionId }),
          );
          const mq = yield* MessageQueue;
          yield* mq.publish("session.workflow", { sessionId }, { maxAttempts: 5 });
        }
      }),
    ),
    Effect.tapError((err) =>
      Effect.logWarning("[processUploadedDocuments] could not send DOCUMENTS_READY to actor", err).pipe(
        Effect.annotateLogs({ sessionId }),
      ),
    ),
    Effect.ignore,
  );
});
