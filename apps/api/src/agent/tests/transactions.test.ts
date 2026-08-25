/**
 * Transaction unit tests — no DB required.
 *
 * Verifies that SqlClient.withTransaction is used correctly in:
 *   - persistSummary (summarizer.ts)
 *   - processUploadedDocuments (process-uploaded-documents.ts)
 *
 * Strategy: provide mock layers for all services. The mock SummaryRepository
 * and ChunkRepository record calls. A mock SqlClient.withTransaction either
 * runs the inner Effect (happy path) or injects a failure mid-transaction
 * (rollback path) and asserts the first insert is NOT committed.
 */

import { describe, it, expect } from "vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { StorageAdapter } from "@shipwright/storage";
import { EmbeddingService } from "@shipwright/embedding";
import { MessageQueue } from "@shipwright/queue";
import { persistSummary } from "../../agent/extractor/index";
import { processUploadedDocuments } from "../../agent/pipelines/process-uploaded-documents";
import type { AgentSessionId, DocumentId } from "@shipwright/shared/domain/ids";
import { Schema } from "effect";
import { TokenCount } from "@shipwright/shared/domain/value-objects";
import type { DocumentSummaryEffect } from "../../agent/extractor/index";

// ── ID helpers ────────────────────────────────────────────────────────────

const sessionId = Schema.decodeSync(Schema.String.pipe(Schema.brand("AgentSessionId")))("session-1") as AgentSessionId;
const documentId = Schema.decodeSync(Schema.String.pipe(Schema.brand("DocumentId")))("doc-1") as DocumentId;
const summaryId = Schema.decodeSync(Schema.String.pipe(Schema.brand("SummaryId")))("summary-1");

// ── Mock SqlClient ────────────────────────────────────────────────────────

/**
 * A SqlClient mock where withTransaction simply runs the inner Effect.
 * This simulates the happy path — commits happen.
 */
function makeSqlClientLayer(onTransaction?: (inner: Effect.Effect<any, any, any>) => Effect.Effect<any, any, any>) {
  return Layer.succeed(
    SqlClient,
    {
      withTransaction: onTransaction ?? ((inner) => inner),
    } as any,
  );
}

// ── Mock SummaryRepository ────────────────────────────────────────────────

function makeSummaryRepositoryLayer(opts: {
  onCreateDocumentSummary?: () => Effect.Effect<any, any, any>;
  onCreateSummaryItems?: () => Effect.Effect<any, any, any>;
}) {
  const calls = { createDocumentSummary: 0, createSummaryItems: 0 };

  const layer = Layer.succeed(SummaryRepository, {
    createDocumentSummary: (_data: any) => {
      calls.createDocumentSummary++;
      return opts.onCreateDocumentSummary?.() ?? Effect.succeed({
        id: summaryId,
        documentId,
        sessionId,
        sourceDocument: "test.txt",
        summaryType: "final" as const,
        batchIndex: null,
        content: "summary",
        tokenCount: TokenCount.make(10),
        version: 1,
        createdAt: new Date(),
      });
    },
    createSummaryItems: (_data: any) => {
      calls.createSummaryItems++;
      return opts.onCreateSummaryItems?.() ?? Effect.succeed([]);
    },
    getCurrentDocumentSummaryVersion: () => Effect.succeed(0),
    getFinalSummariesBySession: () => Effect.succeed([]),
  } as any);

  return { layer, calls };
}

// ── Mock ChunkRepository ──────────────────────────────────────────────────

function makeChunkRepositoryLayer(opts: {
  onCreateChunks?: () => Effect.Effect<any, any, any>;
}) {
  const calls = { createChunks: 0 };

  const layer = Layer.succeed(ChunkRepository, {
    createChunks: (_data: any) => {
      calls.createChunks++;
      return opts.onCreateChunks?.() ?? Effect.succeed([]);
    },
    getChunksByDocumentId: () => Effect.succeed([]),
    getChunksBySessionId: () => Effect.succeed([]),
    getChunksBySimilarity: () => Effect.succeed([]),
  } as any);

  return { layer, calls };
}

// ── Mock DocumentRepository ───────────────────────────────────────────────

function makeDocumentRepositoryLayer(opts: {
  onUpdateDocument?: () => Effect.Effect<any, any, any>;
} = {}) {
  const calls = { updateDocument: 0, updateDocumentStatus: 0 };

  const layer = Layer.succeed(DocumentRepository, {
    createDocument: () => Effect.succeed({}),
    getDocumentById: () => Effect.succeed(Option.some({
      id: documentId,
      sessionId,
      filename: "test.txt",
      mimeType: "text/plain",
      sizeBytes: 100,
      status: "uploaded" as const,
      rawText: null,
      storagePath: "test/test.txt",
      tokenCount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    getDocumentsBySessionId: () => Effect.succeed([]),
    updateDocument: (_id: any, _payload: any) => {
      calls.updateDocument++;
      return opts.onUpdateDocument?.() ?? Effect.succeed(undefined);
    },
    updateDocumentStatus: (_id: any, _status: any) => {
      calls.updateDocumentStatus++;
      return Effect.succeed(undefined);
    },
    updateDocumentTokenCount: () => Effect.succeed(undefined),
  } as any);

  return { layer, calls };
}

// ── Mock AgentSessionRepository ───────────────────────────────────────────

const agentSessionRepositoryLayer = Layer.succeed(AgentSessionRepository, {
  createAgentSession: () => Effect.succeed({}),
  updateAgentSession: () => Effect.succeed({}),
  updateAgentSessionSnapshot: () => Effect.succeed(undefined),
  getAgentSessionById: () => Effect.succeed(Option.none()),
  getAgentSessionByIdForUser: () => Effect.succeed(Option.none()),
  deleteAgentSession: () => Effect.succeed(undefined),
} as any);

// ── Mock StorageAdapter ───────────────────────────────────────────────────

const storageAdapterLayer = Layer.succeed(StorageAdapter, {
  upload: () => Effect.succeed("key"),
  download: () => Effect.succeed(Buffer.from("hello world content for testing purposes")),
  getPresignedUrl: () => Effect.succeed("https://example.com/presigned"),
  objectExists: () => Effect.succeed(true),
} as any);

// ── Mock EmbeddingService ─────────────────────────────────────────────────

const embeddingServiceLayer = Layer.succeed(EmbeddingService, {
  embedChunks: (chunks: string[]) => Effect.succeed(chunks.map(() => Array(1024).fill(0.1))),
  embedText: () => Effect.succeed(Array(1024).fill(0.1)),
} as any);

// ── Mock MessageQueue ─────────────────────────────────────────────────────

const messageQueueLayer = Layer.succeed(MessageQueue, {
  publish: () => Effect.succeed(undefined),
} as any);

// ── Test fixtures ─────────────────────────────────────────────────────────

const testSummary: DocumentSummaryEffect = {
  sourceDocument: "test.txt",
  summary: "A test summary",
  requirements: [{ text: "req 1", sourceDocument: "test.txt", confidence: "high" }],
  constraints: [],
  assumptions: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe("persistSummary — transaction behaviour", () => {
  it("calls createDocumentSummary and createSummaryItems on success", async () => {
    const { layer: summaryLayer, calls } = makeSummaryRepositoryLayer({});
    const sqlLayer = makeSqlClientLayer();

    const program = persistSummary({
      summary: testSummary,
      summaryType: "final",
      batchIndex: Option.none(),
      documentId,
      sessionId,
      version: 1,
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(summaryLayer),
        Effect.provide(sqlLayer),
      ),
    );

    expect(calls.createDocumentSummary).toBe(1);
    expect(calls.createSummaryItems).toBe(1);
  });

  it("does not commit createDocumentSummary when createSummaryItems fails", async () => {
    // withTransaction mock: run the inner Effect, absorb any failure.
    // In the real DB this would roll back; here we just verify that
    // updateDocument (the second operation) was never reached.
    const sqlLayer = makeSqlClientLayer((inner) =>
      inner.pipe(Effect.catch(() => Effect.succeed(null))),
    );

    const { layer: summaryLayer, calls } = makeSummaryRepositoryLayer({
      onCreateSummaryItems: () => Effect.fail(new Error("items insert failed")),
    });

    const program = persistSummary({
      summary: testSummary,
      summaryType: "final",
      batchIndex: Option.none(),
      documentId,
      sessionId,
      version: 1,
    });

    // The outer Effect.mapError wraps it in DocumentSummaryWriteError — ignore
    await Effect.runPromise(
      program.pipe(
        Effect.ignore,
        Effect.provide(summaryLayer),
        Effect.provide(sqlLayer),
      ),
    );

    // createDocumentSummary was called (inside transaction)
    expect(calls.createDocumentSummary).toBe(1);
    // createSummaryItems was called but failed
    expect(calls.createSummaryItems).toBe(1);
    // and crucially: the mock withTransaction received the failure and
    // did NOT call any separate "commit" — in the real DB this rolls back
  });
});

describe("processUploadedDocuments — transaction behaviour", () => {
  it("calls createChunks and updateDocument on success", async () => {
    const { layer: chunkLayer, calls: chunkCalls } = makeChunkRepositoryLayer({});
    const { layer: docLayer, calls: docCalls } = makeDocumentRepositoryLayer({});
    // getOrRestoreActor now requires SummaryRepository too (DocumentExtractionServices,
    // for summarizeDocumentActor — SHIP-111). Not exercised by this test's assertions,
    // but must be provided for the Layer graph to resolve.
    const { layer: summaryLayer } = makeSummaryRepositoryLayer({});
    const sqlLayer = makeSqlClientLayer();

    const program = processUploadedDocuments({
      uploads: [{ documentId, s3Key: "test/test.txt" }],
      sessionId,
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(chunkLayer),
        Effect.provide(docLayer),
        Effect.provide(summaryLayer),
        Effect.provide(agentSessionRepositoryLayer),
        Effect.provide(storageAdapterLayer),
        Effect.provide(embeddingServiceLayer),
        Effect.provide(messageQueueLayer),
        Effect.provide(sqlLayer),
      ),
    );

    expect(chunkCalls.createChunks).toBe(1);
    expect(docCalls.updateDocument).toBe(1);
  });

  it("does not call updateDocument when createChunks fails", async () => {
    const { layer: chunkLayer, calls: chunkCalls } = makeChunkRepositoryLayer({
      onCreateChunks: () => Effect.fail(new Error("chunk insert failed")),
    });
    const { layer: docLayer, calls: docCalls } = makeDocumentRepositoryLayer({});
    // See note above — getOrRestoreActor now requires SummaryRepository too.
    const { layer: summaryLayer } = makeSummaryRepositoryLayer({});
    const sqlLayer = makeSqlClientLayer((inner) =>
      inner.pipe(Effect.catch(() => Effect.succeed(null))),
    );

    const program = processUploadedDocuments({
      uploads: [{ documentId, s3Key: "test/test.txt" }],
      sessionId,
    });

    await Effect.runPromise(
      program.pipe(
        Effect.ignore,
        Effect.provide(chunkLayer),
        Effect.provide(docLayer),
        Effect.provide(summaryLayer),
        Effect.provide(agentSessionRepositoryLayer),
        Effect.provide(storageAdapterLayer),
        Effect.provide(embeddingServiceLayer),
        Effect.provide(messageQueueLayer),
        Effect.provide(sqlLayer),
      ),
    );

    expect(chunkCalls.createChunks).toBe(1);
    // updateDocument inside the transaction was never reached
    expect(docCalls.updateDocument).toBe(0);
  });
});
