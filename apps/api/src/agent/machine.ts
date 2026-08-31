import { assign, createActor, enqueueActions, fromPromise, raise, setup } from "xstate";
import { Context, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  MachineContextEffectSchema,
  type MachineContext,
} from "@shipwright/shared/schemas/machine";
import type { AgentSessionId, DocumentId } from "@shipwright/shared/domain/ids";
import { summarizeDocument } from "./extractor/index";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { LangfuseClient } from "../observability/langfuse-client";

// The real Effect requirements summarizeDocumentActor needs from `services`.
// Unlike wireSnapshotPersistence's Context.Context<never> (which runs an
// already-resolved DB method — see session-actor.ts), summarizeDocument is
// called directly and still has these three services in its own `R`. Typing
// this concretely (not `never`) means the compiler verifies end-to-end that
// getOrRestoreActor's caller chain actually provides them — no runtime trust
// required, unlike the `never` escape hatch used elsewhere in this file.
export type DocumentExtractionServices =
  | ChunkRepository
  | SummaryRepository
  | SqlClient
  | LangfuseClient;

export class SnapshotValidationError extends Schema.TaggedErrorClass<SnapshotValidationError>()(
  "SnapshotValidationError",
  { cause: Schema.Defect() },
) {}

// ── Initial context ────────────────────────────────────────────────────────

export const initialContext: MachineContext = {
  sessionId: "" as AgentSessionId,
  documents: [],
  documentSummaries: [],
  questions: [],
  answers: [],
  round: 0,
  inputMode: "context",
  agentAnalysis: Option.none(),
  revisionFeedback: Option.none(),
  outputVersion: 1,
  outputs: {},
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** All documents have settled (done or failed) — none still pending. */
export function allDocumentsSettled(context: MachineContext): boolean {
  return context.documents.length > 0 && context.documents.every((d) => d.status !== "pending");
}

/** At least one document succeeded extraction. */
export function atLeastOneDocumentDone(context: MachineContext): boolean {
  return context.documents.some((d) => d.status === "done");
}

// ── Guards ─────────────────────────────────────────────────────────────────

// Summary token counts are used (not raw document token counts) per docs/stack.md.
const CONTEXT_TOKEN_THRESHOLD = 100_000;

// Project the DOCUMENT_EXTRACTED event onto context to compute the post-update document list.
// Guards run before actions, so context still reflects pre-event state here.
// Accepts the full event union — narrows internally.
function projectExtracted(context: MachineContext, event: { type: string; [k: string]: unknown }) {
  if (event.type !== "DOCUMENT_EXTRACTED") return context.documents;
  const filename = event.filename as string;
  const status = event.status as "done" | "failed";
  return context.documents.map((d) => (d.filename === filename ? { ...d, status } : d));
}

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

  // All documents settled and at least one succeeded — proceed to processing.
  extractionPartialOrFullSuccess: ({
    context,
    event,
  }: {
    context: MachineContext;
    event: { type: string; [k: string]: unknown };
  }) => {
    const updated = projectExtracted(context, event);
    return (
      allDocumentsSettled({ ...context, documents: updated }) &&
      atLeastOneDocumentDone({ ...context, documents: updated })
    );
  },

  // All documents settled and ALL failed — hard error.
  extractionTotalFailure: ({
    context,
    event,
  }: {
    context: MachineContext;
    event: { type: string; [k: string]: unknown };
  }) => {
    const updated = projectExtracted(context, event);
    return (
      updated.every((d) => d.status !== "pending") && updated.every((d) => d.status === "failed")
    );
  },
} as const;

// ── Machine ────────────────────────────────────────────────────────────────

/**
 * The machine is built by a factory, not exported as a static singleton,
 * because summarizeDocumentActor needs an Effect Context to run
 * summarizeDocument (an Effect) as a Promise (what XState's fromPromise
 * actor logic requires). `services` is captured once per actor lifecycle
 * via `Effect.context<DocumentExtractionServices>()` in getOrRestoreActor
 * (session-actor.ts) and closed over here — the same technique
 * wireSnapshotPersistence already uses to bridge Effect into XState's
 * synchronous `subscribe` callback (Effect.runForkWith there,
 * Effect.runPromiseWith here). Typed concretely as DocumentExtractionServices
 * rather than `never`: the compiler verifies getOrRestoreActor's whole caller
 * chain actually provides ChunkRepository/SummaryRepository/SqlClient before
 * this ever runs — no runtime trust required.
 */
export function createAgentMachine(services: Context.Context<DocumentExtractionServices>) {
  return setup({
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
        // Fired once per document when extraction completes (success or failure).
        // Raised internally by the machine (see the `summarizing` state's
        // xstate.done.actor.* / xstate.error.actor.* handlers) when a spawned
        // per-document actor settles — never sent externally in production.
        // Kept as a public event so guard/action logic can still be unit-tested
        // without spinning up a real spawned actor.
        | { type: "DOCUMENT_EXTRACTED"; filename: string; status: "done" | "failed" }
        // Fired once by the workflow to kick off extraction. documentId travels
        // only in the event payload (used once, at spawn time) — never stored in
        // context, per the "no DB IDs in machine context" rule.
        | { type: "EXTRACTION_STARTED"; documents: { filename: string; documentId: DocumentId }[] }
        // Fired by processUploadedDocuments when all documents finish processing (ready or error).
        // May arrive before or after USER_CONFIRM — the machine handles both orderings.
        | { type: "DOCUMENTS_READY" }
        | { type: "SUMMARIZATION_DONE"; documentSummaries: MachineContext["documentSummaries"] }
        | { type: "OUTPUT_READY"; outputs: MachineContext["outputs"] }
        | { type: "ERROR"; cause: unknown }
        | { type: "REVISION_REQUESTED"; feedback: string },
    },
    guards,
    actors: {
      // The Effect <-> XState bridge for design B (Rule 8 compliance): the
      // Summarizer pass (an Effect) is invoked from inside a spawned actor,
      // not from an external Effect pipeline. Effect.runPromiseWith(context)
      // is the documented way to run an Effect that needs services and get
      // back the Promise that fromPromise requires. This closes over `services`
      // captured by the factory's caller (see createAgentMachine's doc comment).
      summarizeDocumentActor: fromPromise(
        ({
          input,
        }: {
          input: { documentId: DocumentId; sessionId: AgentSessionId; filename: string };
        }) =>
          Effect.runPromiseWith(services)(
            summarizeDocument(input.documentId, input.sessionId, input.filename),
          ),
      ),
    },
    actions: {
      assignGapReport: assign({
        agentAnalysis: ({ event }) => {
          if (event.type !== "ANALYSIS_DONE") return Option.none();
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
      assignExtractionStarted: assign({
        documents: ({ event }) => {
          if (event.type !== "EXTRACTION_STARTED") return [];
          return event.documents.map(({ filename }) => ({ filename, status: "pending" as const }));
        },
      }),
      // Spawns one summarizeDocumentActor per document. Dynamic count (unknown
      // until EXTRACTION_STARTED arrives) rules out static spawnChild calls —
      // enqueueActions + enqueue.spawnChild is the v5 pattern for a runtime-
      // determined number of children. id = filename (already the correlation
      // key used by DOCUMENT_EXTRACTED/assignDocumentExtracted), so the
      // xstate.done.actor.<filename> / xstate.error.actor.<filename> events
      // raised on completion need no separate lookup table.
      spawnDocumentActors: enqueueActions(({ context, event, enqueue }) => {
        if (event.type !== "EXTRACTION_STARTED") return;
        for (const { filename, documentId } of event.documents) {
          enqueue.spawnChild("summarizeDocumentActor", {
            id: filename,
            input: { documentId, sessionId: context.sessionId, filename },
          });
        }
      }),
      assignDocumentExtracted: assign({
        documents: ({ context, event }) => {
          if (event.type !== "DOCUMENT_EXTRACTED") return context.documents;
          return context.documents.map((d) =>
            d.filename === event.filename ? { ...d, status: event.status } : d,
          );
        },
      }),
      assignDocumentSummaries: assign({
        documentSummaries: ({ context, event }) => {
          if (event.type !== "SUMMARIZATION_DONE") return context.documentSummaries;
          return event.documentSummaries;
        },
      }),
      assignOutputs: assign({
        outputs: ({ event }) => {
          if (event.type !== "OUTPUT_READY") return {};
          return event.outputs;
        },
      }),
      assignRevisionFeedback: assign({
        revisionFeedback: ({ event }) => {
          if (event.type !== "REVISION_REQUESTED") return Option.none();
          return Option.some(event.feedback);
        },
        outputVersion: ({ context }) => context.outputVersion + 1,
      }),
      clearRevisionFeedback: assign({ revisionFeedback: Option.none() }),
    },
  }).createMachine({
    id: "agent",
    initial: "idle",
    context: ({ input }) => ({ ...initialContext, ...input }),
    states: {
      idle: { on: { UPLOAD_COMPLETE: "uploading" } },

      // Compound uploading state — two substates handle the two orderings of
      // DOCUMENTS_READY and USER_CONFIRM without a boolean flag:
      //
      //   uploading_pending_docs  → docs still processing, user hasn't confirmed
      //     DOCUMENTS_READY       → uploading_docs_ready  (docs done, waiting for user)
      //     USER_CONFIRM          → waiting_for_documents (user early, waiting for docs)
      //
      //   uploading_docs_ready    → docs done, waiting for user to confirm
      //     USER_CONFIRM          → summarizing           (happy path — docs already ready)
      //
      //   waiting_for_documents   → user confirmed early, docs still processing
      //     DOCUMENTS_READY       → summarizing           (docs caught up)
      uploading: {
        initial: "uploading_pending_docs",
        states: {
          uploading_pending_docs: {
            on: {
              DOCUMENTS_READY: "uploading_docs_ready",
              USER_CONFIRM: "#agent.waiting_for_documents",
              ERROR: "#agent.uploading_error",
            },
          },
          uploading_docs_ready: {
            on: {
              USER_CONFIRM: "#agent.summarizing",
              ERROR: "#agent.uploading_error",
            },
          },
        },
      },

      uploading_error: { type: "final" },

      waiting_for_documents: {
        on: {
          DOCUMENTS_READY: "summarizing",
          ERROR: "uploading_error",
        },
      },

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

      summarizing: {
        on: {
          // Initialise per-doc status tracking, then spawn one actor per document.
          EXTRACTION_STARTED: {
            actions: ["assignExtractionStarted", "spawnDocumentActors"],
          },
          // A spawned summarizeDocumentActor finished (resolved or rejected).
          // Re-dispatch as DOCUMENT_EXTRACTED so the existing guards/actions
          // below run unchanged — raise() enqueues it for immediate processing
          // in this same step. actorId is the filename (see spawnDocumentActors).
          "xstate.done.actor.*": {
            actions: raise(({ event }) => ({
              type: "DOCUMENT_EXTRACTED" as const,
              filename: (event as unknown as { actorId: string }).actorId,
              status: "done" as const,
            })),
          },
          "xstate.error.actor.*": {
            actions: raise(({ event }) => ({
              type: "DOCUMENT_EXTRACTED" as const,
              filename: (event as unknown as { actorId: string }).actorId,
              status: "failed" as const,
            })),
          },
          // Each document actor's outcome, individually.
          DOCUMENT_EXTRACTED: [
            {
              // Last document settled and at least one succeeded — proceed.
              guard: "extractionPartialOrFullSuccess",
              target: "processing",
              actions: "assignDocumentExtracted",
            },
            {
              // Last document settled but ALL failed — hard error.
              guard: "extractionTotalFailure",
              target: "summarizing_error",
              actions: "assignDocumentExtracted",
            },
            {
              // Still waiting for other documents — just update status.
              actions: "assignDocumentExtracted",
            },
          ],
          SUMMARIZATION_DONE: {
            target: "processing",
            actions: "assignDocumentSummaries",
          },
        },
      },

      summarizing_error: { type: "final" },

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
}

// ── Actor factory ──────────────────────────────────────────────────────────

/**
 * Create a new agent actor for a session.
 * `services` is the Effect Context summarizeDocumentActor runs against —
 * see createAgentMachine's doc comment. The caller is responsible for wiring
 * the `subscribe` callback to persist xstateSnapshot to the DB on every
 * transition (Architecture Rule 5).
 */
export function createAgentActor(
  services: Context.Context<DocumentExtractionServices>,
  contextOverride?: Partial<MachineContext>,
) {
  return createActor(createAgentMachine(services), { input: contextOverride ?? {} });
}

/**
 * Restore an agent actor from a serialised XState snapshot (from xstate_snapshot in DB).
 * Validates snapshot.context against MachineContextEffectSchema before restoring.
 * Fails with SnapshotValidationError on schema mismatch — callers should fall back
 * to createAgentActor to avoid serving a corrupt session.
 */
export const restoreAgentActor = Effect.fn("agent/restoreAgentActor")(function* (
  services: Context.Context<DocumentExtractionServices>,
  snapshot: unknown,
) {
  const raw = snapshot as { context?: unknown } | null | undefined;

  // Validate the context shape before handing to XState.
  // XState's createActor throws synchronously on malformed snapshots,
  // so we validate first and surface a typed error instead.
  yield* Schema.decodeUnknownEffect(MachineContextEffectSchema)(raw?.context).pipe(
    Effect.mapError((cause) => new SnapshotValidationError({ cause })),
  );

  return yield* Effect.try({
    try: () => createActor(createAgentMachine(services), { snapshot: snapshot as any, input: {} }),
    catch: (cause) => new SnapshotValidationError({ cause }),
  });
});

export type AgentMachine = ReturnType<typeof createAgentMachine>;
export type AgentActor = ReturnType<typeof createAgentActor>;

// The real state-value type this machine's snapshots carry — derived from
// the actual `states: {...}` chart above, not hand-typed. Anything that
// compares against a state name (session-process-manager.ts's predicates
// and transition→queue routing) should use this, not xstate's generic
// StateValue, so a state rename here is a compile error at every call site
// instead of a silently-always-false comparison.
export type AgentStateValue = ReturnType<AgentActor["getSnapshot"]>["value"];
