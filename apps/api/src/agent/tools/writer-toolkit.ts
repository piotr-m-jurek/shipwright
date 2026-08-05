import { Array, Effect, pipe, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { ChunkRepository } from "../../db/repositories/chunk-repository.ts";
import { DocumentRepository } from "../../db/repositories/document-repository.ts";
import { SummaryRepository } from "../../db/repositories/summary-repository.ts";
import { EmbeddingService } from "../embedding-service.ts";
import { StorageAdapter } from "../../storage/index.ts";

// ── Errors ────────────────────────────────────────────────────────────────────

class DocumentNotFoundError extends Schema.TaggedErrorClass<DocumentNotFoundError>()(
  "shipwright/tools/DocumentNotFoundError",
  { filename: Schema.String },
) {}

class DocumentSummaryNotFoundError extends Schema.TaggedErrorClass<DocumentSummaryNotFoundError>()(
  "shipwright/tools/DocumentSummaryNotFoundError",
  { filename: Schema.String },
) {}

// ── Tool definitions ──────────────────────────────────────────────────────────

const QueryChunksTool = Tool.make("query-chunks", {
  description:
    "Retrieve relevant document chunks by semantic similarity. Use when you need more " +
    "detail on a specific area not covered in the summaries, or to verify a specific claim " +
    "against source material.",
  parameters: Schema.Struct({
    query: Schema.String.annotate({
      description: "A specific question or topic to search for in the source documents",
    }),
    limit: Schema.optionalKey(
      Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    ).annotate({
      description: "Maximum number of chunks to return (1–20, default 5). Omit to use the default.",
    }),
  }),
  success: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        similarity: Schema.Number,
        content: Schema.String,
        headingPath: Schema.NullOr(Schema.Array(Schema.String)),
        pageNumber: Schema.NullOr(Schema.Number),
      }),
    ),
  }),
  failureMode: "return",
});

const GetDocumentTool = Tool.make("get-document", {
  description:
    "Retrieve the full parsed text of a source document by filename. Use when you need " +
    "the complete context of a document — not just matching chunks — before writing a section.",
  parameters: Schema.Struct({
    filename: Schema.String.annotate({
      description: "The exact filename of the document as it appears in the session (e.g. 'requirements.pdf')",
    }),
  }),
  success: Schema.Struct({
    filename: Schema.String,
    content: Schema.String,
    mimeType: Schema.String,
    sizeBytes: Schema.Number,
  }),
  failure: DocumentNotFoundError,
  failureMode: "return",
});

const GetDocumentSummaryTool = Tool.make("get-document-summary", {
  description:
    "Retrieve the final structured summary for a specific document, including extracted " +
    "requirements, constraints, and assumptions. Use when you want to re-read the structured " +
    "analysis of a document before writing a section that depends on it.",
  parameters: Schema.Struct({
    filename: Schema.String.annotate({
      description: "The exact filename of the document as it appears in the session",
    }),
  }),
  success: Schema.Struct({
    filename: Schema.String,
    summary: Schema.String,
    requirements: Schema.Array(Schema.Struct({ text: Schema.String, confidence: Schema.String })),
    constraints: Schema.Array(Schema.Struct({ text: Schema.String, confidence: Schema.String })),
    assumptions: Schema.Array(Schema.Struct({ text: Schema.String, confidence: Schema.String })),
  }),
  failure: DocumentSummaryNotFoundError,
  failureMode: "return",
});

// ── Toolkit ───────────────────────────────────────────────────────────────────

export const WriterToolkit = Toolkit.make(QueryChunksTool, GetDocumentTool, GetDocumentSummaryTool);

// ── Layer factory ─────────────────────────────────────────────────────────────

export const makeWriterToolkitLayer = (sessionId: AgentSessionId) =>
  WriterToolkit.toLayer(
    Effect.gen(function* () {
      const chunkDb = yield* ChunkRepository;
      const documentDb = yield* DocumentRepository;
      const summaryDb = yield* SummaryRepository;
      const embedder = yield* EmbeddingService;
      const storage = yield* StorageAdapter;

      return WriterToolkit.of({
        "query-chunks": Effect.fn("tools/query-chunks")(function* ({ query, limit: rawLimit }) {
          const limit = rawLimit ?? 5;
          const embedding = yield* pipe(
            embedder.embedText(query),
            Effect.tapError((cause) =>
              Effect.logError("query-chunks: embedding failed, falling back to empty results").pipe(
                Effect.annotateLogs({ sessionId, query, cause: String(cause) }),
              ),
            ),
            Effect.catch(() => Effect.succeed([])),
          );
          const results = yield* chunkDb
            .getChunksBySimilarity({ sessionId, embedding, limit })
            .pipe(
              Effect.catch((cause) =>
                Effect.logError("query-chunks: DB query failed", cause).pipe(
                  Effect.as([] as { similarity: number; content: string; headingPath: string[] | null; pageNumber: number | null }[]),
                ),
              ),
            );
          return { results };
        }),

        "get-document": Effect.fn("tools/get-document")(function* ({ filename }) {
          const docs = yield* documentDb.getDocumentsBySessionId(sessionId).pipe(Effect.orDie);
          const doc = yield* Array.findFirst(docs, (d) => d.filename === filename).pipe(
            Effect.fromOption,
            Effect.catchTag("NoSuchElementError", () => new DocumentNotFoundError({ filename })),
          );
          const s3Key = doc.storagePath ?? `${sessionId}/${doc.id}`;
          const raw = yield* storage.download(s3Key).pipe(Effect.orDie);
          return {
            filename: doc.filename,
            content: raw.toString("utf-8"),
            mimeType: doc.mimeType,
            sizeBytes: doc.sizeBytes,
          };
        }),

        "get-document-summary": Effect.fn("tools/get-document-summary")(function* ({ filename }) {
          const summaries = yield* summaryDb.getFinalSummariesBySession(sessionId).pipe(Effect.orDie);
          const summary = yield* Array.findFirst(summaries, (s) => s.sourceDocument === filename).pipe(
            Effect.fromOption,
            Effect.catchTag("NoSuchElementError", () => new DocumentSummaryNotFoundError({ filename })),
          );
          return {
            filename: summary.sourceDocument,
            summary: summary.summary,
            requirements: summary.requirements.map((r) => ({ text: r.text, confidence: r.confidence })),
            constraints: summary.constraints.map((c) => ({ text: c.text, confidence: c.confidence })),
            assumptions: summary.assumptions.map((a) => ({ text: a.text, confidence: a.confidence })),
          };
        }),
      });
    }),
  );
