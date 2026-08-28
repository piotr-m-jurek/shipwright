/**
 * SHIP-111 bridge tests — no DB, no LLM required.
 *
 * Verifies the actual mechanism wired in machine.ts:
 *   EXTRACTION_STARTED -> spawnDocumentActors (enqueueActions + spawnChild,
 *   one per document) -> summarizeDocumentActor (fromPromise wrapping
 *   Effect.runPromiseWith(services)(summarizeDocument(...))) -> on
 *   settlement, xstate.done.actor.* / xstate.error.actor.* -> raise
 *   DOCUMENT_EXTRACTED -> existing guards decide the transition.
 *
 * Uses a real summarizeDocument with a mocked ChunkRepository returning zero
 * chunks, so it fails fast with a real NoChunksError before ever touching
 * SqlClient or the LLM — this exercises the whole new bridge with a real
 * code path, not a stub of the mechanism itself.
 */

import { describe, it, expect } from "vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { waitFor } from "xstate";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import type { AgentSessionId, DocumentId } from "@shipwright/shared/domain/ids";
import { LangfuseClient } from "../../observability/langfuse-client";
import { createAgentActor, type DocumentExtractionServices } from "../machine";

const sessionId = Schema.decodeSync(
  Schema.String.pipe(Schema.brand("AgentSessionId")),
)("session-spawn-test") as AgentSessionId;

function docId(id: string) {
  return Schema.decodeSync(Schema.String.pipe(Schema.brand("DocumentId")))(id) as DocumentId;
}

// Empty chunks for every document -> summarizeDocument fails with NoChunksError
// before ever needing SqlClient/SummaryRepository/the LLM.
const chunkLayer = Layer.succeed(ChunkRepository, {
  getChunksByDocumentId: () => Effect.succeed([]),
} as any);

// Never actually called on this failure path, but summarizeDocument's R
// still names it — provide a layer so the Context can be built.
const summaryLayer = Layer.succeed(SummaryRepository, {} as any);
const sqlLayer = Layer.succeed(SqlClient, {} as any);
const langfuseLayer = Layer.succeed(LangfuseClient, {} as any);

function makeServices(): Context.Context<DocumentExtractionServices> {
  const layer = Layer.mergeAll(chunkLayer, summaryLayer, sqlLayer, langfuseLayer);
  return Effect.runSync(Effect.scoped(Layer.build(layer)));
}

describe("summarizeDocumentActor spawning (SHIP-111 bridge)", () => {
  it("a single document with no chunks fails fast and reaches summarizing_error", async () => {
    const actor = createAgentActor(makeServices(), { sessionId });
    actor.start();
    actor.send({ type: "UPLOAD_COMPLETE" });
    actor.send({ type: "DOCUMENTS_READY" });
    actor.send({ type: "USER_CONFIRM" });
    expect(actor.getSnapshot().value).toBe("summarizing");

    actor.send({
      type: "EXTRACTION_STARTED",
      documents: [{ filename: "only.txt", documentId: docId("doc-only") }],
    });

    const snapshot = await waitFor(actor, (s) => s.matches("summarizing_error"), {
      timeout: 5_000,
    });

    expect(snapshot.value).toBe("summarizing_error");
    expect(snapshot.context.documents).toEqual([{ filename: "only.txt", status: "failed" }]);
    actor.stop();
  });

  it("spawns one actor per document by filename id, and waits for all before transitioning", async () => {
    const actor = createAgentActor(makeServices(), { sessionId });
    actor.start();
    actor.send({ type: "UPLOAD_COMPLETE" });
    actor.send({ type: "DOCUMENTS_READY" });
    actor.send({ type: "USER_CONFIRM" });

    actor.send({
      type: "EXTRACTION_STARTED",
      documents: [
        { filename: "doc-a.txt", documentId: docId("doc-a") },
        { filename: "doc-b.txt", documentId: docId("doc-b") },
      ],
    });

    // Both fail (no chunks) -> total failure -> summarizing_error, and only
    // after BOTH have settled (guard checks allDocumentsSettled).
    const snapshot = await waitFor(actor, (s) => s.matches("summarizing_error"), {
      timeout: 5_000,
    });

    const byFilename = Object.fromEntries(
      snapshot.context.documents.map((d) => [d.filename, d.status]),
    );
    expect(byFilename).toEqual({ "doc-a.txt": "failed", "doc-b.txt": "failed" });
    actor.stop();
  });
});
