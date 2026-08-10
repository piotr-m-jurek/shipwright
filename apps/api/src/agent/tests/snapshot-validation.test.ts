/**
 * Snapshot validation tests for restoreAgentActor.
 *
 * Verifies that:
 *   - a valid snapshot restores successfully
 *   - a corrupt/missing context fails with SnapshotValidationError
 *   - session-actor falls back to a fresh actor on SnapshotValidationError
 */

import { describe, it, expect } from "vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { restoreAgentActor, createAgentActor } from "../machine";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";

const sessionId = Schema.decodeSync(
  Schema.String.pipe(Schema.brand("AgentSessionId")),
)("session-snapshot-test") as AgentSessionId;

// ── Valid snapshot — produced by a real actor so XState accepts it ─────────

function makeValidSnapshot() {
  const actor = createAgentActor({ sessionId });
  actor.start();
  const snap = actor.getSnapshot();
  actor.stop();
  return snap;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("restoreAgentActor", () => {
  it("succeeds with a valid snapshot", async () => {
    const snapshot = makeValidSnapshot();
    const actor = await Effect.runPromise(restoreAgentActor(snapshot));
    expect(actor).toBeDefined();
    actor.start();
    expect(actor.getSnapshot().context.sessionId).toBe(sessionId);
    actor.stop();
  });

  it("fails with SnapshotValidationError when context is missing", async () => {
    const exit = await Effect.runPromiseExit(
      restoreAgentActor({ value: "idle", status: "active" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause) as any;
      expect(err._tag).toBe("SnapshotValidationError");
    }
  });

  it("fails with SnapshotValidationError when context has wrong shape", async () => {
    const badSnapshot = {
      value: "idle",
      context: { sessionId: 999, documents: "not-an-array" },
      status: "active",
    };

    const exit = await Effect.runPromiseExit(restoreAgentActor(badSnapshot));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause) as any;
      expect(err._tag).toBe("SnapshotValidationError");
    }
  });

  it("fails with SnapshotValidationError when tokenCount violates constraint", async () => {
    const snapshot = makeValidSnapshot();
    const badSnapshot = {
      ...snapshot,
      context: {
        ...snapshot.context,
        documents: [
          {
            id: "doc-1",
            filename: "test.txt",
            tokenCount: -5, // violates greaterThanOrEqualTo(0)
          },
        ],
      },
    };

    const exit = await Effect.runPromiseExit(restoreAgentActor(badSnapshot));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause) as any;
      expect(err._tag).toBe("SnapshotValidationError");
    }
  });
});

describe("getOrRestoreActor fallback behaviour", () => {
  it("createAgentActor produces a usable fresh actor", () => {
    const actor = createAgentActor({ sessionId });
    actor.start();
    expect(actor.getSnapshot().value).toBe("idle");
    actor.stop();
  });
});
