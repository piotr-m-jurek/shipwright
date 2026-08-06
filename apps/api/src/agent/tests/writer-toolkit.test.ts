/**
 * Unit tests for WriterToolkit tools.
 *
 * Tests each tool's happy path and its typed failure path.
 * All external services are mocked with Layer.succeed — no DB or S3 required.
 *
 * Each tool is exercised via `toolkit.handle(name, params)` which runs the
 * handler through the full Toolkit machinery (schema validation, result
 * encoding, failure detection).
 */

import { describe, it, expect } from "vitest";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { DocumentRepository } from "../../db/repositories/document-repository.ts";
import { SummaryRepository } from "../../db/repositories/summary-repository.ts";
import { ChunkRepository } from "../../db/repositories/chunk-repository.ts";
import { EmbeddingService } from "../embedding-service.ts";
import { StorageAdapter } from "../../storage/index.ts";
import { makeWriterToolkitLayer, WriterToolkit } from "../writer/tools/writer-toolkit.ts";
import type { AgentSessionId, DocumentId } from "@shipwright/shared/domain/ids";
import { TokenCount } from "@shipwright/shared/domain/value-objects";

// ── ID helpers ────────────────────────────────────────────────────────────────

const sessionId = Schema.decodeSync(
  Schema.String.pipe(Schema.brand("AgentSessionId")),
)("session-1") as AgentSessionId;

const documentId = Schema.decodeSync(
  Schema.String.pipe(Schema.brand("DocumentId")),
)("doc-1") as DocumentId;

// ── Mock fixtures ─────────────────────────────────────────────────────────────

const mockDoc = {
  id: documentId,
  sessionId,
  filename: "requirements.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  status: "ready" as const,
  rawText: null,
  storagePath: "session-1/doc-1",
  tokenCount: TokenCount.make(200),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSummary = {
  id: Schema.decodeSync(Schema.String.pipe(Schema.brand("SummaryId")))("sum-1"),
  documentId,
  sessionId,
  sourceDocument: "requirements.pdf",
  summary: "This document describes the requirements for the auth system.",
  tokenCount: TokenCount.make(50),
  version: 1,
  requirements: [{ text: "Users must log in", sourceDocument: "requirements.pdf", confidence: "high" as const }],
  constraints: [{ text: "Must use OAuth2", sourceDocument: "requirements.pdf", confidence: "medium" as const }],
  assumptions: [],
};

// ── Mock layers ───────────────────────────────────────────────────────────────

const makeDocumentRepositoryLayer = (docs = [mockDoc]) =>
  Layer.succeed(DocumentRepository, {
    getDocumentsBySessionId: () => Effect.succeed(docs),
    getDocumentById: () => Effect.succeed(Option.some(mockDoc)),
    createDocument: () => Effect.succeed(mockDoc),
    updateDocument: () => Effect.succeed(undefined),
    updateDocumentStatus: () => Effect.succeed(undefined),
    updateDocumentTokenCount: () => Effect.succeed(undefined),
  } as any);

const makeSummaryRepositoryLayer = (summaries = [mockSummary]) =>
  Layer.succeed(SummaryRepository, {
    getFinalSummariesBySession: () => Effect.succeed(summaries),
    createDocumentSummary: () => Effect.succeed({}),
    createSummaryItems: () => Effect.succeed([]),
    getCurrentDocumentSummaryVersion: () => Effect.succeed(0),
  } as any);

const makeChunkRepositoryLayer = (results = [] as any[]) =>
  Layer.succeed(ChunkRepository, {
    getChunksBySimilarity: () => Effect.succeed(results),
    createChunks: () => Effect.succeed([]),
    getChunksByDocumentId: () => Effect.succeed([]),
    getChunksBySessionId: () => Effect.succeed([]),
  } as any);

const makeEmbeddingServiceLayer = () =>
  Layer.succeed(EmbeddingService, {
    embedText: () => Effect.succeed(Array(1024).fill(0.1)),
    embedChunks: (chunks: string[]) => Effect.succeed(chunks.map(() => Array(1024).fill(0.1))),
  } as any);

const makeStorageAdapterLayer = (content = "full document text") =>
  Layer.succeed(StorageAdapter, {
    download: () => Effect.succeed(Buffer.from(content)),
    upload: () => Effect.succeed(undefined),
    remove: () => Effect.succeed(undefined),
    generatePresignedUrl: () => Effect.succeed("https://presigned"),
    generatePresignedGetUrl: () => Effect.succeed("https://presigned-get"),
    headObject: () => Effect.succeed(true),
    downloadPartialObject: () => Effect.succeed(Buffer.from(content)),
  } as any);

// ── Helper: build toolkit layer and run a program against it ─────────────────

function makeTestLayer(overrides: {
  docs?: typeof mockDoc[];
  summaries?: typeof mockSummary[];
  chunks?: any[];
  fileContent?: string;
} = {}) {
  return makeWriterToolkitLayer(sessionId).pipe(
    Layer.provide(makeDocumentRepositoryLayer(overrides.docs ?? [mockDoc])),
    Layer.provide(makeSummaryRepositoryLayer(overrides.summaries ?? [mockSummary])),
    Layer.provide(makeChunkRepositoryLayer(overrides.chunks ?? [])),
    Layer.provide(makeEmbeddingServiceLayer()),
    Layer.provide(makeStorageAdapterLayer(overrides.fileContent ?? "full document text")),
  );
}

/** Invoke a tool via toolkit.handle, collect the final HandlerResult. */
function callTool<Name extends "query-chunks" | "get-document" | "get-document-summary">(
  name: Name,
  params: any,
  overrides?: Parameters<typeof makeTestLayer>[0],
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const toolkit = yield* WriterToolkit;
      const stream = yield* toolkit.handle(name, params);
      const last = yield* Stream.runLast(stream);
      return Option.getOrThrow(last);
    }).pipe(Effect.provide(makeTestLayer(overrides))),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WriterToolkit — query-chunks", () => {
  it("returns matching chunks", async () => {
    const mockChunks = [
      { similarity: 0.9, content: "auth requirements section", headingPath: ["Auth"], pageNumber: 1 },
    ];

    const handlerResult = await callTool("query-chunks", { query: "authentication", limit: 5 }, { chunks: mockChunks });

    expect(handlerResult.isFailure).toBe(false);
    const result = handlerResult.result as { results: typeof mockChunks };
    expect(result.results).toHaveLength(1);
    expect(result.results[0].content).toBe("auth requirements section");
    expect(result.results[0].similarity).toBe(0.9);
  });

  it("returns empty results when no chunks match", async () => {
    const handlerResult = await callTool("query-chunks", { query: "unrelated topic" }, { chunks: [] });

    expect(handlerResult.isFailure).toBe(false);
    const result = handlerResult.result as { results: any[] };
    expect(result.results).toHaveLength(0);
  });
});

describe("WriterToolkit — get-document", () => {
  it("returns full document content for a known filename", async () => {
    const handlerResult = await callTool(
      "get-document",
      { filename: "requirements.pdf" },
      { fileContent: "full parsed document content" },
    );

    expect(handlerResult.isFailure).toBe(false);
    const result = handlerResult.result as { filename: string; content: string; mimeType: string; sizeBytes: number };
    expect(result.filename).toBe("requirements.pdf");
    expect(result.content).toBe("full parsed document content");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.sizeBytes).toBe(1024);
  });

  it("returns DocumentNotFoundError for unknown filename", async () => {
    const handlerResult = await callTool(
      "get-document",
      { filename: "nonexistent.pdf" },
      { docs: [] },
    );

    expect(handlerResult.isFailure).toBe(true);
    const result = handlerResult.result as { _tag: string; filename: string };
    expect(result._tag).toBe("shipwright/tools/DocumentNotFoundError");
    expect(result.filename).toBe("nonexistent.pdf");
  });
});

describe("WriterToolkit — get-document-summary", () => {
  it("returns structured summary for a known filename", async () => {
    const handlerResult = await callTool("get-document-summary", { filename: "requirements.pdf" });

    expect(handlerResult.isFailure).toBe(false);
    const result = handlerResult.result as {
      filename: string;
      summary: string;
      requirements: { text: string; confidence: string }[];
      constraints: { text: string; confidence: string }[];
      assumptions: { text: string; confidence: string }[];
    };
    expect(result.filename).toBe("requirements.pdf");
    expect(result.summary).toContain("auth system");
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0].text).toBe("Users must log in");
    expect(result.requirements[0].confidence).toBe("high");
    expect(result.constraints).toHaveLength(1);
    expect(result.assumptions).toHaveLength(0);
  });

  it("returns DocumentSummaryNotFoundError for unknown filename", async () => {
    const handlerResult = await callTool(
      "get-document-summary",
      { filename: "nonexistent.pdf" },
      { summaries: [] },
    );

    expect(handlerResult.isFailure).toBe(true);
    const result = handlerResult.result as { _tag: string; filename: string };
    expect(result._tag).toBe("shipwright/tools/DocumentSummaryNotFoundError");
    expect(result.filename).toBe("nonexistent.pdf");
  });
});
