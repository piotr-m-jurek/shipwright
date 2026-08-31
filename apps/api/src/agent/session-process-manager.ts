/**
 * SessionProcessManager — the single place that knows what an XState value
 * means for orchestration purposes: which queue message follows a given
 * transition, and the named preconditions/error-branch checks handlers and
 * pipelines need before or after sending an event to the actor.
 *
 * Before this existed, `actor.getSnapshot().value === "..."` comparisons and
 * ad-hoc `mq.publish("...")` calls were scattered across session-compute.ts,
 * process-uploaded-documents.ts, submit-answers.ts, generation.ts, and
 * run-session-workflow.ts — every state rename or restructure meant hunting
 * down every call site by hand. This module is that lookup table.
 */
import { Effect } from "effect";
import { MessageQueue } from "@shipwright/queue";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import type { AgentStateValue } from "./machine";

/** The flat (non-compound) state names — what a map keyed by state name can hold. */
type FlatState = Extract<AgentStateValue, string>;

// ── Queue names ────────────────────────────────────────────────────────────

export const SessionQueue = {
  documentsProcess: "documents.process",
  sessionWorkflow: "session.workflow",
  sessionGenerate: "session.generate",
  sessionRevise: "session.revise",
} as const;

export type SessionQueueName = (typeof SessionQueue)[keyof typeof SessionQueue];

// ── Queue routing ────────────────────────────────────────────────────────
//
// Single source of truth: which queue message follows which machine state.
// Add an entry here — not at a call site — when a new transition needs to
// trigger a queue publish. maxAttempts carries over the exact retry budget
// each transition already had before this consolidation (they weren't all
// the same — session.workflow used 5, session.generate/session.revise used
// the queue's default — preserved as-is, not silently harmonized).

const TRANSITION_QUEUE_MAP: Partial<Record<FlatState, { queue: SessionQueueName; maxAttempts?: number }>> = {
  summarizing: { queue: SessionQueue.sessionWorkflow, maxAttempts: 5 },
  generating: { queue: SessionQueue.sessionGenerate },
  revising: { queue: SessionQueue.sessionRevise },
};

/**
 * Publish the queue message (if any) associated with the given state value.
 * No-ops when the state has no associated transition (including compound
 * state values like `{ uploading: "uploading_pending_docs" }` — the map is
 * only keyed by the flat state names that actually trigger a publish).
 */
export const publishForCurrentState = Effect.fn("agent/publishForCurrentState")(function* (
  sessionId: AgentSessionId,
  stateValue: AgentStateValue,
) {
  if (typeof stateValue !== "string") return;

  const route = TRANSITION_QUEUE_MAP[stateValue];
  if (route === undefined) return;

  yield* Effect.logInfo(`[SessionProcessManager] ${stateValue} → publishing ${route.queue}`).pipe(
    Effect.annotateLogs({ sessionId, state: stateValue, queue: route.queue }),
  );

  const mq = yield* MessageQueue;
  yield* mq.publish(
    route.queue,
    { sessionId },
    route.maxAttempts !== undefined ? { maxAttempts: route.maxAttempts } : undefined,
  );
});

// ── State predicates ─────────────────────────────────────────────────────
//
// Named checks for the preconditions/error-branches that read a state value
// without triggering a publish. Each wraps exactly the comparison it
// replaces — no behavior change, just a name and one home for the machine's
// state vocabulary.

/** `idle` — before the first UPLOAD_COMPLETE. */
export const isIdle = (stateValue: AgentStateValue): boolean => stateValue === "idle";

/** The compound `uploading` state (uploading_pending_docs | uploading_docs_ready). */
export const isUploading = (stateValue: AgentStateValue): boolean =>
  typeof stateValue === "object" && stateValue !== null && "uploading" in stateValue;

/** `awaiting_answers` — the clarifying-questions loop is waiting on the user. */
export const isAwaitingAnswers = (stateValue: AgentStateValue): boolean =>
  stateValue === "awaiting_answers";

/** `complete` — outputs generated, session is done pending a possible revision. */
export const isComplete = (stateValue: AgentStateValue): boolean => stateValue === "complete";

/** `summarizing_error` — every spawned per-document extraction actor failed. */
export const isSummarizingError = (stateValue: AgentStateValue): boolean =>
  stateValue === "summarizing_error";
