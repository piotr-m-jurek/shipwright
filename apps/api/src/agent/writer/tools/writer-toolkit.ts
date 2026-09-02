import { Array, Effect, Layer, Option, pipe, Schema } from "effect";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { AnthropicClientLayer, AnthropicHaikuModelLayer } from "../../providers";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { EmbeddingService } from "@shipwright/embedding";
import { StorageAdapter } from "@shipwright/storage";
import { Spans } from "@shipwright/observability";
import { LangfuseClient } from "../../../observability/langfuse-client";

// ── Errors ────────────────────────────────────────────────────────────────────

class DocumentNotFoundError extends Schema.TaggedError<DocumentNotFoundError>()(
  "shipwright/tools/DocumentNotFoundError",
  { filename: Schema.String },
) {}

class DocumentSummaryNotFoundError extends Schema.TaggedError<DocumentSummaryNotFoundError>()(
  "shipwright/tools/DocumentSummaryNotFoundError",
  { filename: Schema.String },
) {}

// ── Tool definitions ──────────────────────────────────────────────────────────

// Score threshold below which the writer must revise the failing section.
// Intentionally section-level (not full-draft) revision:
// re-generating the full draft re-spends all input tokens (summaries + Q&A context),
// which is expensive. Targeting only the deficient section costs a fraction of that.
const SCORE_COMPLETENESS_THRESHOLD = 0.85;

const ScoreCompletenessTool = Tool.make("score-completeness", {
  description:
    "Evaluate a named section of the document you just drafted for completeness against " +
    "the source summaries. Call this after writing each major section. " +
    `If the returned score is below ${SCORE_COMPLETENESS_THRESHOLD}, rewrite that section only — ` +
    "do not regenerate the full document.",
  parameters: Schema.Struct({
    sectionName: Schema.String.annotate({
      description:
        "The exact heading name of the section being evaluated (e.g. '## Key Constraints')",
    }),
    sectionContent: Schema.String.annotate({
      description: "The full text of the section you just wrote",
    }),
    sourceSummaryContext: Schema.String.annotate({
      description:
        "The relevant portion of the source summaries that this section should reflect. " +
        "Include requirements, constraints, or assumptions the section must cover.",
    }),
  }),
  success: Schema.Struct({
    score: Schema.Finite.annotate({ description: "Completeness score 0.0–1.0" }),
    reasoning: Schema.String.annotate({ description: "Why this score was given" }),
    missedItems: Schema.Array(Schema.String).annotate({
      description: "Specific items from the source context that are absent from the section",
    }),
    pass: Schema.Boolean.annotate({
      description: `true if score >= ${SCORE_COMPLETENESS_THRESHOLD}`,
    }),
  }),
  failureMode: "return",
});

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
      Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
    ).annotate({
      description: "Maximum number of chunks to return (1–20, default 5). Omit to use the default.",
    }),
  }),
  success: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        similarity: Schema.Finite,
        content: Schema.String,
        headingPath: Schema.NullOr(Schema.Array(Schema.String)),
        pageNumber: Schema.NullOr(Schema.Finite),
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
      description:
        "The exact filename of the document as it appears in the session (e.g. 'requirements.pdf')",
    }),
  }),
  success: Schema.Struct({
    filename: Schema.String,
    content: Schema.String,
    mimeType: Schema.String,
    sizeBytes: Schema.Finite,
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

export const WriterToolkit = Toolkit.make(
  QueryChunksTool,
  GetDocumentTool,
  GetDocumentSummaryTool,
  ScoreCompletenessTool,
);

export { SCORE_COMPLETENESS_THRESHOLD };

// ── Layer factory ─────────────────────────────────────────────────────────────

export const makeWriterToolkitLayer = (sessionId: AgentSessionId) =>
  WriterToolkit.toLayer(
    Effect.gen(function* () {
      const chunkDb = yield* ChunkRepository;
      const documentDb = yield* DocumentRepository;
      const summaryDb = yield* SummaryRepository;
      const embedder = yield* EmbeddingService;
      const storage = yield* StorageAdapter;
      const langfuse = yield* LangfuseClient;

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
                  Effect.as(
                    [] as {
                      similarity: number;
                      content: string;
                      headingPath: string[] | null;
                      pageNumber: number | null;
                    }[],
                  ),
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
          const summaries = yield* summaryDb
            .getFinalSummariesBySession(sessionId)
            .pipe(Effect.orDie);
          const summary = yield* Array.findFirst(
            summaries,
            (s) => s.sourceDocument === filename,
          ).pipe(
            Effect.fromOption,
            Effect.catchTag(
              "NoSuchElementError",
              () => new DocumentSummaryNotFoundError({ filename }),
            ),
          );
          return {
            filename: summary.sourceDocument,
            summary: summary.summary,
            requirements: summary.requirements.map((r) => ({
              text: r.text,
              confidence: r.confidence,
            })),
            constraints: summary.constraints.map((c) => ({
              text: c.text,
              confidence: c.confidence,
            })),
            assumptions: summary.assumptions.map((a) => ({
              text: a.text,
              confidence: a.confidence,
            })),
          };
        }),

        "score-completeness": Effect.fn("tools/score-completeness")(function* ({
          sectionName,
          sectionContent,
          sourceSummaryContext,
        }) {
          const judgePrompt = `You are a completeness auditor for a document section.

You will receive:
1. A section name and its drafted content
2. The source summary context that section should reflect

Your job: identify specific requirements, constraints, or assumptions from the source context that are NOT reflected in the section.

Score 0.0–1.0 where 1.0 = fully complete, 0.0 = critical items missing.
Pass threshold: ${SCORE_COMPLETENESS_THRESHOLD}

Respond with JSON:
{
  "score": 0.0-1.0,
  "reasoning": "...",
  "missedItems": ["item not covered", ...],
  "pass": true/false
}`;

          // Fetch prompt from Langfuse registry; fall back to hardcoded if unavailable.
          const promptResult = yield* langfuse.getPrompt("shipwright-score-completeness");
          const systemPrompt = Option.match(promptResult, {
            onNone: () => judgePrompt,
            onSome: (p) => p.text,
          });
          yield* Option.match(promptResult, {
            onNone: () => Effect.void,
            onSome: (p) =>
              Effect.annotateCurrentSpan(Spans.prompt({ name: p.name, version: p.version })),
          });

          const userContent = `## Section: ${sectionName}\n\n${sectionContent}\n\n## Source Context\n\n${sourceSummaryContext}`;

          const response = yield* LanguageModel.generateObject({
            schema: Schema.Struct({
              score: Schema.Finite,
              reasoning: Schema.String,
              missedItems: Schema.Array(Schema.String),
              pass: Schema.Boolean,
            }),
            prompt: Prompt.make([
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent },
            ]),
          }).pipe(
            Effect.provide(Layer.provideMerge(AnthropicHaikuModelLayer, AnthropicClientLayer)),
            Effect.orDie,
          );

          const modelId = response.content.find((p) => p.type === "response-metadata")?.modelId;
          yield* Effect.annotateCurrentSpan(
            Spans.llm({
              model: modelId,
              inputTokens: response.usage.inputTokens.total,
              outputTokens: response.usage.outputTokens.total,
              cacheReadTokens: response.usage.inputTokens.cacheRead,
            }),
          );

          return response.value;
        }),
      });
    }),
  );
