import { describe, it, expect } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { JobStore } from "effect-mq";
import { publishForCurrentState, isUploading } from "../session-process-manager";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";

const sessionId = Schema.decodeSync(
  Schema.String.pipe(Schema.brand("AgentSessionId")),
)("session-1") as AgentSessionId;

// ── Mock JobStore — records every enqueue call ──────────────────────────────
// publishForCurrentState calls SessionWorkflow/SessionGenerate/SessionRevise
// .enqueue(...) (from @shipwright/queue), which internally resolve the
// default JobStore service and call store.enqueue(request) — mocking that
// one service covers all three Job classes without mocking each separately.

function makeJobStoreLayer() {
  const calls: { name: string; queue: string; payload: unknown; attemptsMax: number }[] = [];
  const layer = Layer.succeed(JobStore.JobStore, {
    enqueue: (request: { name: string; queue: string; payload: unknown; attemptsMax: number }) => {
      calls.push({
        name: request.name,
        queue: request.queue,
        payload: request.payload,
        attemptsMax: request.attemptsMax,
      });
      return Effect.succeed({ id: "job-1", duplicate: false });
    },
  } as any);
  return { layer, calls };
}

function runWithQueue<A>(effect: Effect.Effect<A, never, JobStore.JobStore>) {
  const { layer, calls } = makeJobStoreLayer();
  const result = Effect.runSync(effect.pipe(Effect.provide(layer)));
  return { result, calls };
}

// ── publishForCurrentState — routing table ──────────────────────────────────

describe("publishForCurrentState", () => {
  it("enqueues session.workflow with attemptsMax 5 for summarizing", () => {
    const { calls } = runWithQueue(publishForCurrentState(sessionId, "summarizing"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: "session.workflow",
      queue: "session.workflow",
      payload: { sessionId },
      attemptsMax: 5,
    });
  });

  it("enqueues session.generate with the job's default attemptsMax for generating", () => {
    const { calls } = runWithQueue(publishForCurrentState(sessionId, "generating"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: "session.generate",
      queue: "session.generate",
      payload: { sessionId },
      attemptsMax: 3,
    });
  });

  it("enqueues session.revise with the job's default attemptsMax for revising", () => {
    const { calls } = runWithQueue(publishForCurrentState(sessionId, "revising"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: "session.revise",
      queue: "session.revise",
      payload: { sessionId },
      attemptsMax: 3,
    });
  });

  it("does not enqueue for a state with no routing entry", () => {
    const { calls } = runWithQueue(publishForCurrentState(sessionId, "idle"));
    expect(calls).toHaveLength(0);
  });

  it("does not enqueue for a compound state value", () => {
    const { calls } = runWithQueue(
      publishForCurrentState(sessionId, { uploading: "uploading_pending_docs" } as any),
    );
    expect(calls).toHaveLength(0);
  });
});

// ── isUploading — the one predicate with real conditional logic ────────────

describe("isUploading", () => {
  it("is true for the compound uploading state (pending_docs)", () =>
    expect(isUploading({ uploading: "uploading_pending_docs" } as any)).toBe(true));
  it("is true for the compound uploading state (docs_ready)", () =>
    expect(isUploading({ uploading: "uploading_docs_ready" } as any)).toBe(true));
  it("is false for a flat state string", () => expect(isUploading("idle")).toBe(false));
});
