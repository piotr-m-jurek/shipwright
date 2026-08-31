import { describe, it, expect } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { MessageQueue } from "@shipwright/queue";
import { SessionQueue, publishForCurrentState, isUploading } from "../session-process-manager";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";

const sessionId = Schema.decodeSync(
  Schema.String.pipe(Schema.brand("AgentSessionId")),
)("session-1") as AgentSessionId;

// ── Mock MessageQueue — records every publish call ──────────────────────────

function makeMessageQueueLayer() {
  const calls: { queue: string; payload: unknown; opts: unknown }[] = [];
  const layer = Layer.succeed(MessageQueue, {
    publish: (queue: string, payload: unknown, opts?: unknown) => {
      calls.push({ queue, payload, opts });
      return Effect.succeed("message-id");
    },
  } as any);
  return { layer, calls };
}

function runWithQueue<A>(effect: Effect.Effect<A, never, MessageQueue>) {
  const { layer, calls } = makeMessageQueueLayer();
  const result = Effect.runSync(effect.pipe(Effect.provide(layer)));
  return { result, calls };
}

// ── publishForCurrentState — routing table ──────────────────────────────────

describe("publishForCurrentState", () => {
  it("publishes session.workflow with maxAttempts 5 for summarizing", () => {
    const { calls } = runWithQueue(publishForCurrentState(sessionId, "summarizing"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      queue: SessionQueue.sessionWorkflow,
      payload: { sessionId },
      opts: { maxAttempts: 5 },
    });
  });

  it("publishes session.generate with no maxAttempts override for generating", () => {
    const { calls } = runWithQueue(publishForCurrentState(sessionId, "generating"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      queue: SessionQueue.sessionGenerate,
      payload: { sessionId },
      opts: undefined,
    });
  });

  it("publishes session.revise with no maxAttempts override for revising", () => {
    const { calls } = runWithQueue(publishForCurrentState(sessionId, "revising"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      queue: SessionQueue.sessionRevise,
      payload: { sessionId },
      opts: undefined,
    });
  });

  it("does not publish for a state with no routing entry", () => {
    const { calls } = runWithQueue(publishForCurrentState(sessionId, "idle"));
    expect(calls).toHaveLength(0);
  });

  it("does not publish for a compound state value", () => {
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
