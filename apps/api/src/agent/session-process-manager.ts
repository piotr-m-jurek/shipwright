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
import { SessionWorkflow, SessionGenerate, SessionRevise } from "@shipwright/queue";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import type { AgentStateValue } from "./machine";

/** The flat (non-compound) state names — what a map keyed by state name can hold. */
type FlatState = Extract<AgentStateValue, string>;

// ── Queue routing ────────────────────────────────────────────────────────
//
// Single source of truth: which job follows which machine state. Add a case
// here — not at a call site — when a new transition needs to enqueue a job.
// attempts carries over the exact retry budget each transition already had
// before this consolidation (they weren't all the same — session.workflow
// used 5, session.generate/session.revise used the default 1 — preserved
// as-is, not silently harmonized).
//
// documents.process isn't state-transition-triggered (published directly
// from session-storage.ts/retry-session.ts), so it has no case here.

/**
 * Enqueue the job (if any) associated with the given state value. No-ops
 * when the state has no associated transition (including compound state
 * values like `{ uploading: "uploading_pending_docs" }` — only the flat
 * state names below trigger an enqueue).
 */
export const publishForCurrentState = Effect.fn("agent/publishForCurrentState")(function* (
  sessionId: AgentSessionId,
  stateValue: AgentStateValue,
) {
  if (typeof stateValue !== "string") return;

  const state = stateValue as FlatState;
  if (state !== "summarizing" && state !== "generating" && state !== "revising") return;

  yield* Effect.logInfo(`[SessionProcessManager] ${state} → enqueuing job`).pipe(
    Effect.annotateLogs({ sessionId, state }),
  );

  switch (state) {
    case "summarizing":
      yield* SessionWorkflow.enqueue({ sessionId }, { attempts: 5 });
      return;
    case "generating":
      yield* SessionGenerate.enqueue({ sessionId });
      return;
    case "revising":
      yield* SessionRevise.enqueue({ sessionId });
      return;
  }
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
