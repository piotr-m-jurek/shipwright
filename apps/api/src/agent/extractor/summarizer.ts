import { Effect, Schema, Option, pipe, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Spans } from "@shipwright/observability";
import type { Chunk, SummaryItemType } from "@shipwright/shared/domain/types";
import type { AgentSessionId, DocumentId } from "@shipwright/shared/domain/ids";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { TextGenerationError } from "../errors";
import { estimateTokenCount } from "../lib/estimate-token-count";
import { LanguageModel, Prompt } from "effect/unstable/ai";
import { type DocumentSummaryEffect, DocumentSummaryEffectSchema } from "./schemas";
import { AnthropicClientLayer, AnthropicHaikuModelLayer } from "../providers";

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
  sessionId: AgentSessionId,
) {
  yield* Effect.annotateCurrentSpan(Spans.session(sessionId));
  const documentDb = yield* DocumentRepository;

  return yield* pipe(
    documentDb.getDocumentsBySessionId(sessionId),
    Effect.flatMap(
      Effect.forEach((doc) => summarizeDocument(doc.id, sessionId, doc.filename), {
        concurrency: 2,
      }),
    ),
    Effect.mapError((cause) => new ChunksRetrievalError({ cause })),
  );
});

export const summarizeDocument = Effect.fn("agent/summarizeDocument")(function* (
  documentId: DocumentId,
  sessionId: AgentSessionId,
  filename: string,
) {
  yield* Effect.annotateCurrentSpan({
    ...Spans.session(sessionId),
    ...Spans.document({ filename, id: documentId }),
  });
  const chunkDb = yield* ChunkRepository;
  const summaryDb = yield* SummaryRepository;
  const chunks = yield* pipe(
    chunkDb.getChunksByDocumentId(documentId),
    Effect.mapError((cause) => new ChunksRetrievalError({ cause })),
  );

  if (chunks.length === 0) {
    return yield* new NoChunksError();
  }

  yield* Effect.annotateCurrentSpan({ "shipwright.chunk.total": chunks.length });
  yield* Effect.logInfo(`[summarizeDocument] processing ${chunks.length} chunks`).pipe(
    Effect.annotateLogs({ documentId, sessionId, filename }),
  );

  const currentHighestVersion = yield* pipe(
    summaryDb.getCurrentDocumentSummaryVersion({ documentId, sessionId }),
    Effect.mapError((cause) => new DocumentSummaryReadError({ cause })),
  );

  let current: Option.Option<DocumentSummaryEffect> = Option.none();
  for (const chunk of chunks) {
    yield* Effect.logInfo(
      `[summarizeDocument] chunk ${chunk.chunkIndex + 1}/${chunks.length}`,
    ).pipe(Effect.annotateLogs({ documentId, sessionId, chunkIndex: chunk.chunkIndex }));
    const summary = yield* runReducePass(current, chunk, filename);
    yield* persistSummary({
      summary,
      summaryType: "map_intermediate",
      batchIndex: Option.some(chunk.chunkIndex),
      documentId,
      sessionId,
      version: currentHighestVersion,
    });
    current = Option.some(summary);
  }

  if (Option.isNone(current)) {
    yield* Effect.logError(
      "[summarizeDocument] no summary produced after processing all chunks",
    ).pipe(Effect.annotateLogs({ documentId, sessionId, chunkCount: chunks.length }));
  }
  const final = Option.getOrThrow(current);
  return yield* persistSummary({
    summary: final,
    summaryType: "final",
    batchIndex: Option.none(),
    documentId,
    sessionId,
    version: currentHighestVersion + 1,
  });
});

export const persistSummary = Effect.fn("persistSummary")(
  function* ({
    summary,
    summaryType,
    batchIndex,
    documentId,
    sessionId,
    version,
  }: {
    summary: DocumentSummaryEffect;
    summaryType: "map_intermediate" | "final";
    batchIndex: Option.Option<number>;
    documentId: DocumentId;
    sessionId: AgentSessionId;
    version: number;
  }) {
    yield* Effect.annotateCurrentSpan({
      ...Spans.session(sessionId),
      "shipwright.document.id": documentId,
      "shipwright.summary.type": summaryType,
      "shipwright.summary.version": version,
      ...Option.match(batchIndex, {
        onNone: () => ({}),
        onSome: (i) => ({ "shipwright.summary.batch_index": i }),
      }),
    });
    const summaryDb = yield* SummaryRepository;
    const sql = yield* SqlClient;

    const row = yield* pipe(
      Effect.gen(function* () {
        const r = yield* summaryDb.createDocumentSummary({
          documentId,
          sessionId,
          sourceDocument: summary.sourceDocument,
          summaryType,
          batchIndex: Option.getOrNull(batchIndex),
          content: summary.summary,
          tokenCount: estimateTokenCount(summary.summary),
          version,
        });

        const toItems = (items: DocumentSummaryEffect["requirements"], itemType: SummaryItemType) =>
          items.map((item, i) => ({
            summaryId: r.id,
            itemType,
            text: item.text,
            sourceDocument: item.sourceDocument,
            confidence: item.confidence,
            orderIndex: i,
          }));

        yield* summaryDb.createSummaryItems([
          ...toItems(summary.requirements, "requirement"),
          ...toItems(summary.constraints, "constraint"),
          ...toItems(summary.assumptions, "assumption"),
        ]);

        return r;
      }),
      sql.withTransaction,
    );

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

export const runReducePass = Effect.fn("agent/runReducePass")(
  function* (current: Option.Option<DocumentSummaryEffect>, chunk: Chunk, sourceDocument: string) {
    yield* Effect.annotateCurrentSpan({
      ...Spans.document({ filename: sourceDocument }),
      ...Spans.chunk(chunk.chunkIndex),
    });
    const userContent = formatChunk(current, chunk, sourceDocument);

    const response = yield* pipe(
      LanguageModel.generateObject({
        schema: DocumentSummaryEffectSchema,
        prompt: Prompt.make([
          { role: "system", content: MapReduceSystemPrompt },
          { role: "user", content: userContent },
        ]),
      }),
      Effect.mapError((cause) => new TextGenerationError({ cause })),
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
  },
  Effect.provide(Layer.provideMerge(AnthropicHaikuModelLayer, AnthropicClientLayer)),
);

const formatChunk = (
  summary: Option.Option<DocumentSummaryEffect>,
  chunk: Chunk,
  sourceDocument: string,
) => {
  const chunkContent = `=== chunk from: ${sourceDocument} ===\n${chunk.content}`;
  return Option.match(summary, {
    onNone: () => chunkContent,
    onSome: (s) => [`=== running summary ===\n${s.summary}`, chunkContent].join("\n\n"),
  });
};
