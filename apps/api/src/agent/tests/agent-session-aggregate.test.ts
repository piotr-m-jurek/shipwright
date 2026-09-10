/**
 * AgentSessionAggregate.requireSessionAcceptsDocuments — precondition
 * boundary tests (SHIP-179/180/181 rework). Accepts idle/uploading/complete,
 * rejects the busy pipeline states — checked against one representative
 * busy state (analyzing), not an exhaustive matrix.
 *
 * Each case uses its own sessionId — getOrRestoreActor caches actors in a
 * module-level registry keyed by sessionId, so reusing one id across cases
 * would silently reuse the first case's actor instead of re-reading the
 * mocked snapshot.
 */

import { describe, it, expect } from "vitest";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { AgentSessionSnapshotReader } from "@shipwright/db/repositories/agent-session-snapshot-reader";
import type { AgentSessionId, UserId } from "@shipwright/shared/domain/ids";
import { LangfuseClient } from "../../observability/langfuse-client";
import { AiModels } from "@shipwright/ai";
import { createAgentActor } from "../machine";
import { AgentSessionAggregate } from "../agent-session-aggregate";

function sid(id: string) {
  return Schema.decodeSync(Schema.String.pipe(Schema.brand("AgentSessionId")))(id) as AgentSessionId;
}

const userId = Schema.decodeSync(Schema.String.pipe(Schema.brand("UserId")))("user-1") as UserId;

const chunkLayer = Layer.succeed(ChunkRepository, {} as any);
const summaryLayer = Layer.succeed(SummaryRepository, {} as any);
const sqlLayer = Layer.succeed(SqlClient, {} as any);
const langfuseLayer = Layer.succeed(LangfuseClient, {} as any);
const aiModelsLayer = Layer.succeed(AiModels, {} as any);

function servicesFor(sessionId: AgentSessionId, value: unknown) {
  const fresh = createAgentActor(
    Effect.runSync(
      Effect.scoped(
        Layer.build(Layer.mergeAll(chunkLayer, summaryLayer, sqlLayer, langfuseLayer, aiModelsLayer)),
      ),
    ),
    { sessionId },
  );
  fresh.start();
  const xstateSnapshot = { ...fresh.getSnapshot(), value };
  fresh.stop();

  const agentSessionRepositoryLayer = Layer.succeed(AgentSessionRepository, {
    updateAgentSessionSnapshot: () => Effect.succeed(undefined),
  } as any);

  const snapshotReaderLayer = Layer.succeed(AgentSessionSnapshotReader, {
    getUnsafe: () =>
      Effect.succeed(
        Option.some({
          id: sessionId,
          createdAt: new Date(),
          updatedAt: new Date(),
          userId,
          status: "idle",
          inputMode: "context",
          errorReason: null,
          xstateSnapshot,
        }),
      ),
  } as any);

  return Layer.mergeAll(
    chunkLayer,
    summaryLayer,
    sqlLayer,
    langfuseLayer,
    aiModelsLayer,
    agentSessionRepositoryLayer,
    snapshotReaderLayer,
    AgentSessionAggregate.layer,
  );
}

describe("AgentSessionAggregate.requireSessionAcceptsDocuments (SHIP-179/180/181)", () => {
  it.each(["idle", "uploading", "complete"])("accepts from %s", async (value) => {
    const sessionId = sid(`session-accepts-${value}`);
    const layer = servicesFor(sessionId, value);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const aggregate = yield* AgentSessionAggregate;
        yield* aggregate.requireSessionAcceptsDocuments(sessionId);
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("rejects from a busy pipeline state (analyzing)", async () => {
    const sessionId = sid("session-rejects-analyzing");
    const layer = servicesFor(sessionId, "analyzing");

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const aggregate = yield* AgentSessionAggregate;
        yield* aggregate.requireSessionAcceptsDocuments(sessionId);
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
