/**
 * SHIP-179 — DOCUMENT_ADDED transition tests.
 *
 * Verifies that `complete` accepts DOCUMENT_ADDED and reuses summarizing's
 * own entry actions (assignExtractionStarted, spawnDocumentActors) exactly
 * as EXTRACTION_STARTED does — same mechanism as the SHIP-111 bridge tests
 * in document-actor-spawn.test.ts, just entered from `complete` instead of
 * the initial uploading→summarizing path.
 *
 * A `complete`-state snapshot is built by taking a real fresh actor's
 * (valid, schema-passing) snapshot and overriding `value` — same technique
 * snapshot-validation.test.ts uses for its bad-snapshot cases — rather than
 * driving a real actor through the full initial pipeline just to reach
 * `complete`, which would require real chunk/summary data.
 */

import { describe, it, expect } from "vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { waitFor } from "xstate";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import type { AgentSessionId, DocumentId } from "@shipwright/shared/domain/ids";
import { LangfuseClient } from "../../observability/langfuse-client";
import { restoreAgentActor, createAgentActor, type DocumentExtractionServices } from "../machine";

const sessionId = Schema.decodeSync(
  Schema.String.pipe(Schema.brand("AgentSessionId")),
)("session-document-added-test") as AgentSessionId;

function docId(id: string) {
  return Schema.decodeSync(Schema.String.pipe(Schema.brand("DocumentId")))(id) as DocumentId;
}

// Same "empty chunks -> fails fast with NoChunksError before ever touching
// SqlClient/SummaryRepository/the LLM" pattern as document-actor-spawn.test.ts.
const chunkLayer = Layer.succeed(ChunkRepository, {
  getChunksByDocumentId: () => Effect.succeed([]),
} as any);
const summaryLayer = Layer.succeed(SummaryRepository, {} as any);
const sqlLayer = Layer.succeed(SqlClient, {} as any);
const langfuseLayer = Layer.succeed(LangfuseClient, {} as any);

function makeServices(): Context.Context<DocumentExtractionServices> {
  const layer = Layer.mergeAll(chunkLayer, summaryLayer, sqlLayer, langfuseLayer);
  return Effect.runSync(Effect.scoped(Layer.build(layer)));
}

async function makeCompleteActor(services: Context.Context<DocumentExtractionServices>) {
  const fresh = createAgentActor(services, { sessionId });
  fresh.start();
  const idleSnapshot = fresh.getSnapshot();
  fresh.stop();

  const completeSnapshot = { ...idleSnapshot, value: "complete" };
  const actor = await Effect.runPromise(restoreAgentActor(services, completeSnapshot));
  actor.start();
  return actor;
}

describe("DOCUMENT_ADDED transition (SHIP-179)", () => {
  it("complete -> summarizing, assigns the new document, spawns exactly one actor", async () => {
    const services = makeServices();
    const actor = await makeCompleteActor(services);
    expect(actor.getSnapshot().value).toBe("complete");

    actor.send({
      type: "DOCUMENT_ADDED",
      documents: [{ filename: "follow-up.txt", documentId: docId("doc-follow-up") }],
    });

    const snap = actor.getSnapshot();
    expect(snap.value).toBe("summarizing");
    expect(snap.context.documents).toEqual([{ filename: "follow-up.txt", status: "pending" }]);

    // The spawned actor fails fast (no chunks) -> total failure (only one
    // document) -> summarizing_error. Confirms exactly one actor was spawned
    // for the new document, reusing the same DOCUMENT_EXTRACTED/guard path
    // EXTRACTION_STARTED already exercises.
    const settled = await waitFor(actor, (s) => s.matches("summarizing_error"), { timeout: 5_000 });
    expect(settled.context.documents).toEqual([{ filename: "follow-up.txt", status: "failed" }]);
    actor.stop();
  });

  it("REVISION_REQUESTED still transitions complete -> revising, unaffected by the new event", async () => {
    const services = makeServices();
    const actor = await makeCompleteActor(services);

    actor.send({ type: "REVISION_REQUESTED", feedback: "please tighten the acceptance criteria" });

    expect(actor.getSnapshot().value).toBe("revising");
    actor.stop();
  });
});
