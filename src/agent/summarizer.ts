import { Effect, Schema, Option, pipe } from "effect";
import { SelectChunk } from "../shared/schemas/index.js";
import { DocumentSummary, DocumentSummarySchema } from "../shared/schemas/agent.js";
import { DatabaseService } from "../db/queries.js";
import { SummaryItemInsert } from "../db/schema.js";
import { generateText, ModelMessage, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { TextGenerationError } from "./errors.js";
import { estimateTokenCount } from "./estimate-token-count.js";

class ChunksRetrievalError extends Schema.TaggedErrorClass<ChunksRetrievalError>()(
  "ChunksRetrievalError",
  { cause: Schema.Defect() },
) {}

class DocumentSummaryWriteError extends Schema.TaggedErrorClass<DocumentSummaryWriteError>()(
  "DocumentSummaryWriteError",
  { cause: Schema.Defect() },
) {}

class NoChunksError extends Schema.TaggedErrorClass<NoChunksError>()("NoChunksError", {}) {}

class DocumentSummaryReadError extends Schema.TaggedErrorClass<DocumentSummaryReadError>()(
  "DocumentSummaryReadError",
  { cause: Schema.Defect() },
) {}

export const summarizeAllDocuments = Effect.fn("agent/summarizeAllDocuments")(function* (
  sessionId: string,
) {
  const db = yield* DatabaseService;
  return yield* pipe(
    db.getDocumentsBySessionId(sessionId),
    Effect.map(
      Effect.forEach((doc) => summarizeDocument(doc.id, sessionId, doc.filename), {
        concurrency: 2,
      }),
    ),
    Effect.mapError((cause) => new ChunksRetrievalError({ cause })),
  );
});

export const summarizeDocument = Effect.fn("agent/summarizeDocument")(function* (
  documentId: string,
  sessionId: string,
  filename: string,
) {
  const db = yield* DatabaseService;
  const chunks = yield* pipe(
    db.getChunksByDocumentId(documentId),
    Effect.mapError((cause) => new ChunksRetrievalError({ cause })),
  );

  if (chunks.length === 0) {
    return yield* new NoChunksError();
  }

  const currentHighestVersion = yield* pipe(
    db.getCurrentDocumenSummaryVersion({ documentId, sessionId }),
    Effect.mapError((cause) => new DocumentSummaryReadError({ cause })),
  );

  let current: Option.Option<DocumentSummary> = Option.none();
  for (const chunk of chunks) {
    const summary = yield* runReducePass(current, chunk, filename);
    yield* persistSummary({
      summary,
      summaryType: "map_intermediate",
      batchIndex: chunk.chunkIndex,
      documentId,
      sessionId,
      version: currentHighestVersion,
    });
    current = Option.some(summary);
  }

  const final = Option.getOrThrow(current);
  return yield* persistSummary({
    summary: final,
    summaryType: "final",
    documentId,
    sessionId,
    version: currentHighestVersion + 1,
  });
});

// Shared persist helper — inserts into document_summaries then batch-inserts items.
// Used by both intermediate and final persists.
const persistSummary = Effect.fn("persistSummary")(
  function* ({
    summary,
    summaryType,
    batchIndex,
    documentId,
    sessionId,
    version,
  }: {
    summary: DocumentSummary;
    summaryType: "map_intermediate" | "final";
    batchIndex?: number;
    documentId: string;
    sessionId: string;
    version: number;
  }) {
    const db = yield* DatabaseService;
    const row = yield* db.createDocumentSummary({
      documentId,
      sessionId,
      sourceDocument: summary.sourceDocument,
      summaryType,
      batchIndex: batchIndex ?? null,
      content: summary.summary,
      tokenCount: estimateTokenCount(summary.summary),
      version,
    });

    const toItems = (
      items: DocumentSummary["requirements"],
      itemType: SummaryItemInsert["itemType"],
    ): SummaryItemInsert[] =>
      items.map((item, i) => ({
        summaryId: row.id,
        itemType,
        text: item.text,
        sourceDocument: item.sourceDocument,
        confidence: item.confidence,
        orderIndex: i,
      }));

    yield* db.createSummaryItems([
      ...toItems(summary.requirements, "requirement"),
      ...toItems(summary.constraints, "constraint"),
      ...toItems(summary.assumptions, "assumption"),
    ]);

    return row;
  },
  Effect.mapError((cause) => new DocumentSummaryWriteError({ cause })),
);

const MapReduceSystemPrompt = `
You are a document analysis assistant. Your job is to extract structured information from project documents — briefs, PRDs, RFPs, and transcripts.

You will receive either:
- A single chunk of a document (first pass), or
- A running summary of earlier chunks followed by a new chunk (subsequent passes)

Your task is to produce a DocumentSummary that captures the full information seen so far.

OUTPUT RULES — follow these exactly:
1. sourceDocument: set to the exact filename provided in the chunk header. Never invent or alter it.
2. summary: a concise prose paragraph integrating everything seen so far. When a running summary is present, retain its information — do not drop or contradict it unless the new chunk explicitly supersedes it.
3. requirements: functional or non-functional things the project must do or support. Extract only what is explicitly stated or clearly implied by the source text.
4. constraints: hard limits — budget, timeline, technology mandates, compliance requirements, out-of-scope items.
5. assumptions: things the document takes for granted but does not prove — implicit decisions, unstated dependencies, things that would need to change if circumstances changed.

For every item in requirements, constraints, and assumptions:
- text: a single, specific statement
- sourceDocument: the exact filename from the chunk header
- confidence: "high" if stated explicitly, "medium" if clearly implied, "low" if inferred

ANTI-HALLUCINATION RULE: Do not add any requirement, constraint, or assumption that cannot be traced to the provided text. If the chunk contains no requirements, return an empty array — do not invent placeholders.

When a running summary is present: the new chunk is additional evidence, not a replacement. Merge both into a single coherent output.
  `;

export const runReducePass = Effect.fn("agent/runReducePass")(function* (
  current: Option.Option<DocumentSummary>,
  chunk: SelectChunk,
  sourceDocument: string,
) {
  const userContent = formatChunk(current, chunk, sourceDocument);
  const messages: ModelMessage[] = [{ role: "user", content: userContent }];

  const result = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model: anthropic("claude-haiku-4-5"),
        output: Output.object({ schema: DocumentSummarySchema }),
        system: MapReduceSystemPrompt,
        messages,
      }),
    catch: (cause) => new TextGenerationError({ cause }),
  });
  return result.output;
});

const formatChunk = (
  summary: Option.Option<DocumentSummary>,
  chunk: SelectChunk,
  sourceDocument: string,
) => {
  const chunkContent = `=== chunk from: ${sourceDocument} ===\n${chunk.content}`;
  return Option.match(summary, {
    onNone: () => chunkContent,
    onSome: (s) => [`=== running summary ===\n${s.summary}`, chunkContent].join("\n\n"),
  });
};
