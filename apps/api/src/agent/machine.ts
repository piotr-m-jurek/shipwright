import { assign, createActor, setup } from "xstate";
import type { MachineContext } from "@shipwright/shared/schemas/machine.js";

// ── Initial context ────────────────────────────────────────────────────────

export const initialContext: MachineContext = {
  sessionId: "",
  documents: [],
  documentSummaries: [],
  questions: [],
  answers: [],
  round: 0,
  inputMode: "context",
  agentAnalysis: null,
  revisionFeedback: null,
  outputVersion: 1,
  outputs: {},
};

// ── Guards ─────────────────────────────────────────────────────────────────

// Summary token counts are used (not raw document token counts) per docs/stack.md.
const CONTEXT_TOKEN_THRESHOLD = 100_000;

const guards = {
  // true → all summary token counts fit in context window
  tokensBelowThreshold: ({ context }: { context: MachineContext }) => {
    const total = context.documentSummaries.reduce((sum, s) => sum + s.tokenCount, 0);
    return total <= CONTEXT_TOKEN_THRESHOLD;
  },

  // true → clarifying loop has reached its limit (max 2 rounds)
  roundLimitReached: ({ context }: { context: MachineContext }) => context.round >= 2,

  // inverse of roundLimitReached — used in the ANSWERS_INSUFFICIENT branch
  roundLimitNotReached: ({ context }: { context: MachineContext }) => context.round < 2,
} as const;

// ── Machine ────────────────────────────────────────────────────────────────

export const agentMachine = setup({
  types: {
    context: {} as MachineContext,
    input: {} as Partial<MachineContext>,
    events: {} as
      | { type: "UPLOAD_COMPLETE" }
      | { type: "USER_CONFIRM" }
      | {
          type: "ANALYSIS_DONE";
          gapReport: MachineContext["agentAnalysis"];
          questions: MachineContext["questions"];
        }
      | { type: "USER_ANSWERED"; answers: MachineContext["answers"] }
      | { type: "ANSWERS_SUFFICIENT"; questions: MachineContext["questions"] }
      | { type: "ANSWERS_INSUFFICIENT"; questions: MachineContext["questions"] }
      | { type: "OUTPUT_READY"; outputs: MachineContext["outputs"] }
      | { type: "ERROR"; cause: unknown }
      | { type: "REVISION_REQUESTED"; feedback: string },
  },
  guards,
  actions: {
    assignGapReport: assign({
      agentAnalysis: ({ event }) => {
        if (event.type !== "ANALYSIS_DONE") return null;
        return event.gapReport;
      },
      questions: ({ event }) => {
        if (event.type !== "ANALYSIS_DONE") return [];
        return event.questions;
      },
    }),
    assignQuestionsFromSufficient: assign({
      questions: ({ event }) => {
        if (event.type !== "ANSWERS_SUFFICIENT") return [];
        return event.questions;
      },
    }),
    assignQuestionsFromInsufficient: assign({
      questions: ({ event }) => {
        if (event.type !== "ANSWERS_INSUFFICIENT") return [];
        return event.questions;
      },
    }),
    assignAnswers: assign({
      answers: ({ context, event }) => {
        if (event.type !== "USER_ANSWERED") return context.answers;
        return [...context.answers, ...event.answers];
      },
      round: ({ context }) => context.round + 1,
    }),
    assignOutputs: assign({
      outputs: ({ event }) => {
        if (event.type !== "OUTPUT_READY") return {};
        return event.outputs;
      },
    }),
    assignRevisionFeedback: assign({
      revisionFeedback: ({ event }) => {
        if (event.type !== "REVISION_REQUESTED") return null;
        return event.feedback;
      },
      outputVersion: ({ context }) => context.outputVersion + 1,
    }),
    clearRevisionFeedback: assign({ revisionFeedback: null }),
  },
}).createMachine({
  id: "agent",
  initial: "idle",
  context: ({ input }) => ({ ...initialContext, ...input }),

  states: {
    idle: { on: { UPLOAD_COMPLETE: "uploading" } },

    uploading: {
      on: {
        USER_CONFIRM: "processing",
        ERROR: "uploading_error",
      },
    },

    uploading_error: { type: "final" },

    processing: {
      on: {
        // USER_CONFIRM triggers analysis — guard decides context vs retrieval mode
        USER_CONFIRM: [
          {
            guard: "tokensBelowThreshold",
            target: "analyzing",
            actions: assign({ inputMode: "context" }),
          },
          {
            target: "analyzing",
            actions: assign({ inputMode: "retrieval" }),
          },
        ],
        ERROR: "processing_error",
      },
    },

    processing_error: { type: "final" },

    analyzing: {
      // Suspend point — waits for external ANALYSIS_DONE event.
      // The summarizer + challenger are invoked externally; when done
      // they fire ANALYSIS_DONE carrying the gap report.
      on: {
        ANALYSIS_DONE: {
          target: "awaiting_answers",
          actions: "assignGapReport",
        },
        ERROR: "analyzing_error",
      },
    },

    analyzing_error: {
      type: "final",
    },

    awaiting_answers: {
      // Primary HITL suspend point — machine waits for USER_ANSWERED.
      // No ERROR transition by design (V1): session blocks until user responds.
      // Server restart is handled via xstateSnapshot rehydration.
      on: {
        USER_ANSWERED: {
          target: "re_evaluating",
          actions: "assignAnswers",
        },
      },
    },

    re_evaluating: {
      on: {
        ANSWERS_SUFFICIENT: {
          target: "generating",
          actions: "assignQuestionsFromSufficient",
        },
        ANSWERS_INSUFFICIENT: [
          {
            // Round limit not yet reached — loop back for more questions
            guard: "roundLimitNotReached",
            target: "awaiting_answers",
            actions: "assignQuestionsFromInsufficient",
          },
          {
            // Round limit reached — force through to generating regardless
            guard: "roundLimitReached",
            target: "generating",
            actions: "assignQuestionsFromInsufficient",
          },
        ],
        ERROR: "re_evaluating_error",
      },
    },

    re_evaluating_error: {
      type: "final",
    },

    generating: {
      on: {
        OUTPUT_READY: {
          target: "complete",
          actions: ["assignOutputs", "clearRevisionFeedback"],
        },
        ERROR: "generating_error",
      },
    },

    generating_error: {
      type: "final",
    },

    complete: {
      on: {
        REVISION_REQUESTED: {
          target: "revising",
          actions: "assignRevisionFeedback",
        },
      },
    },

    revising: {
      on: {
        // New questions surfaced during revision
        ANALYSIS_DONE: {
          target: "awaiting_answers",
          actions: "assignGapReport",
        },
        // No new questions — go straight to regenerating
        OUTPUT_READY: {
          target: "complete",
          actions: ["assignOutputs", "clearRevisionFeedback"],
        },
        ERROR: "revising_error",
      },
    },

    revising_error: {
      type: "final",
    },
  },
});

// ── Actor factory ──────────────────────────────────────────────────────────

/**
 * Create a new agent actor for a session.
 * The caller is responsible for wiring the `subscribe` callback to persist
 * xstateSnapshot to the DB on every transition (Architecture Rule 5).
 */
export function createAgentActor(contextOverride?: Partial<MachineContext>) {
  return createActor(agentMachine, { input: contextOverride ?? {} });
}

/**
 * Restore an agent actor from a serialised XState snapshot (from xstate_snapshot in DB).
 * Validates the snapshot is parseable before restoring — corrupt snapshots throw.
 */
export function restoreAgentActor(snapshot: unknown) {
  // input is required by the type when `input` is declared on the machine,
  // but XState ignores it when a snapshot is provided — the snapshot's context wins.
  return createActor(agentMachine, { snapshot: snapshot as any, input: {} });
}

export type AgentMachine = typeof agentMachine;
export type AgentActor = ReturnType<typeof createAgentActor>;
