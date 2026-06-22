/**
 * Session actor registry.
 *
 * Keeps one AgentActor per session in memory. On first access for a session
 * it either creates a fresh actor or rehydrates from the DB snapshot
 * (Architecture Rule 5 — server restart recovery).
 *
 * Each actor has a subscribe() callback that persists xstateSnapshot to the DB
 * on every state transition. This is the Rule 5 implementation.
 */

import { Effect, Schema } from "effect";
import {
  getAgentSesionById,
  updateAgentSessionSnapshot,
  createQuestions,
  createAnswers,
  createOutput,
  getFinalSummariesBySession,
  getDocumentsBySessionId,
  getAnswersBySessionId,
  getQuestionsBySessionId,
} from "../db/queries.js";
import { createAgentActor, restoreAgentActor, type AgentActor } from "./machine.js";
import { MachineContextSchema, type MachineContext } from "../shared/schemas/machine.js";
import { summarizeAllDocuments } from "./summarizer.js";
import { runChallenger } from "./challenger.js";
import { runQuestionGenerator } from "./question-generator.js";
import { runBriefWriter } from "./writer-brief.js";
import { runPrdWriter } from "./writer-prd.js";

// ── Error types ────────────────────────────────────────────────────────────

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "shipwright/agent/SessionNotFoundError",
  {},
) {}

export class SessionStateError extends Schema.TaggedErrorClass<SessionStateError>()(
  "shipwright/agent/SessionStateError",
  { message: Schema.String },
) {}

export class AnalysisPipelineError extends Schema.TaggedErrorClass<AnalysisPipelineError>()(
  "shipwright/agent/AnalysisPipelineError",
  { cause: Schema.Defect() },
) {}

// ── Actor registry ─────────────────────────────────────────────────────────

// In-process registry: sessionId → running actor.
// On server restart the map is empty; actors are restored lazily from DB snapshots.
const registry = new Map<string, AgentActor>();

/**
 * Get or restore the actor for a session.
 * If the actor is already running, returns it immediately.
 * If not, loads the xstateSnapshot from the DB and restores it.
 */
export const getOrRestoreActor = Effect.fn("agent/getOrRestoreActor")(function* (
  sessionId: string,
) {
  const existing = registry.get(sessionId);
  if (existing) return existing;

  const session = yield* Effect.tryPromise({
    try: () => getAgentSesionById(sessionId),
    catch: () => new SessionNotFoundError(),
  });

  if (!session) return yield* new SessionNotFoundError();

  let actor: AgentActor;

  if (session.xstateSnapshot) {
    // Validate snapshot before restoring — catches schema corruption
    const parsed = MachineContextSchema.safeParse((session.xstateSnapshot as any)?.context);
    if (!parsed.success) {
      return yield* new SessionStateError({
        message: `Corrupt xstateSnapshot for session ${sessionId}`,
      });
    }
    actor = restoreAgentActor(session.xstateSnapshot);
  } else {
    actor = createAgentActor({ sessionId });
  }

  wireSnapshotPersistence(actor, sessionId);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
});

/**
 * Create a fresh actor for a new session, register it, and start it.
 * Called after confirm-upload when the session is brand new.
 */
export function createAndRegisterActor(sessionId: string): AgentActor {
  const actor = createAgentActor({ sessionId });
  wireSnapshotPersistence(actor, sessionId);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
}

/**
 * Wire Rule 5: persist xstateSnapshot on every state transition.
 * Runs async fire-and-forget — errors are logged but do not crash the actor.
 */
// XState states that map to the 'error' value in the Postgres session_status enum.
const ERROR_STATES = new Set([
  "uploading_error",
  "processing_error",
  "analyzing_error",
  "re_evaluating_error",
  "generating_error",
  "revising_error",
]);

function wireSnapshotPersistence(actor: AgentActor, sessionId: string): void {
  actor.subscribe((snapshot) => {
    const xstateState = snapshot.value as string;
    // Map XState error substates to the 'error' enum value in Postgres.
    const dbStatus = ERROR_STATES.has(xstateState) ? "error" : xstateState;
    updateAgentSessionSnapshot(sessionId, dbStatus as any, snapshot).catch((err) => {
      console.error(
        `[session-actor] Failed to persist snapshot for ${sessionId} (state: ${xstateState}):`,
        err,
      );
    });
  });
}

// ── Analysis pipeline ──────────────────────────────────────────────────────

/**
 * Run the full analysis pipeline for a session:
 *   summarizeAllDocuments → runChallenger → runQuestionGenerator
 *   → persist questions → fire ANALYSIS_DONE on the actor
 *
 * This is invoked from the getSessionProgress handler and runs async
 * (forkDetach pattern). The actor advances through states as each
 * step completes and fires events.
 */
export const runAnalysisPipeline = Effect.fn("agent/runAnalysisPipeline")(function* (
  sessionId: string,
) {
  const actor = yield* getOrRestoreActor(sessionId);

  // 1. Summarize all documents
  yield* summarizeAllDocuments(sessionId).pipe(
    Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
  );

  // 2. Load final summaries
  const summaries = yield* Effect.tryPromise({
    try: () => getFinalSummariesBySession(sessionId),
    catch: (cause) => new AnalysisPipelineError({ cause }),
  });

  // 3. Run Challenger
  const gapReport = yield* runChallenger(summaries).pipe(
    Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
  );

  // 4. Generate clarifying questions
  const { questions: generatedQuestions } = yield* runQuestionGenerator(gapReport, summaries).pipe(
    Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
  );

  // 5. Persist questions to DB before suspending
  const persistedQuestions = yield* Effect.tryPromise({
    try: () =>
      createQuestions(
        generatedQuestions.map((q, i) => ({
          sessionId,
          text: q.text,
          rationale: q.rationale,
          sourceDocuments: q.sourceDocuments,
          orderIndex: i,
        })),
      ),
    catch: (cause) => new AnalysisPipelineError({ cause }),
  });

  // 6. Fire ANALYSIS_DONE — machine transitions to awaiting_answers
  actor.send({
    type: "ANALYSIS_DONE",
    gapReport,
    questions: persistedQuestions.map((q) => ({
      id: q.id,
      text: q.text,
      rationale: q.rationale,
      sourceDocuments: q.sourceDocuments,
    })),
  });
});

// ── Answer submission ──────────────────────────────────────────────────────

/**
 * Submit answers for the current clarifying round.
 * Persists answers to DB, fires USER_ANSWERED, then evaluates whether
 * answers are sufficient and fires ANSWERS_SUFFICIENT or ANSWERS_INSUFFICIENT.
 *
 * Sufficiency check: if all answers are non-empty and the round is >= 1,
 * treat as sufficient. The heuristic can be replaced with an LLM judge later.
 */
export const submitAnswers = Effect.fn("agent/submitAnswers")(function* (
  sessionId: string,
  rawAnswers: { questionId: string; text: string }[],
) {
  const actor = yield* getOrRestoreActor(sessionId);

  const state = actor.getSnapshot().value;
  if (state !== "awaiting_answers") {
    return yield* new SessionStateError({
      message: `Session ${sessionId} is in state '${state}', expected 'awaiting_answers'`,
    });
  }

  const round = actor.getSnapshot().context.round;

  // Persist answers to DB
  const persistedAnswers = yield* Effect.tryPromise({
    try: () =>
      createAnswers(
        rawAnswers.map((a) => ({
          sessionId,
          questionId: a.questionId,
          text: a.text,
          round,
        })),
      ),
    catch: (cause) => new AnalysisPipelineError({ cause }),
  });

  // Fire USER_ANSWERED — machine → re_evaluating, round increments
  actor.send({
    type: "USER_ANSWERED",
    answers: persistedAnswers.map((a) => ({
      questionId: a.questionId,
      text: a.text,
      round: a.round,
    })),
  });

  // Simple sufficiency heuristic: answers are sufficient if all are non-empty
  // and this is round >= 1 (at least one full cycle). Extend with LLM judge later.
  const allAnswered = rawAnswers.every((a) => a.text.trim().length > 0);
  const sufficient = allAnswered && round >= 1;

  // Load latest questions from context for the response
  const currentQuestions = actor.getSnapshot().context.questions;

  if (sufficient) {
    actor.send({ type: "ANSWERS_SUFFICIENT", questions: currentQuestions });
  } else {
    actor.send({ type: "ANSWERS_INSUFFICIENT", questions: currentQuestions });
  }

  // If machine is now in generating state, fork the writer pipeline
  const stateAfter = actor.getSnapshot().value as string;
  if (stateAfter === "generating") {
    yield* runGeneratingPipeline(sessionId).pipe(
      Effect.tapError((e) =>
        Effect.sync(() => console.error("[session-actor] generating pipeline error:", e)),
      ),
      Effect.forkDetach,
    );
  }

  return { sufficient, round: round + 1 };
});

// ── Generating pipeline ────────────────────────────────────────────────────

/**
 * Run both writer passes (Brief + PRD), store in `outputs` table, fire OUTPUT_READY.
 * Invoked from the generating state — called after ANSWERS_SUFFICIENT or roundLimitReached.
 */
export const runGeneratingPipeline = Effect.fn("agent/runGeneratingPipeline")(function* (
  sessionId: string,
) {
  const actor = yield* getOrRestoreActor(sessionId);

  // Load the data the writers need
  const summaries = yield* Effect.tryPromise({
    try: () => getFinalSummariesBySession(sessionId),
    catch: (cause) => new AnalysisPipelineError({ cause }),
  });

  const allAnswers = yield* Effect.tryPromise({
    try: () => getAnswersBySessionId(sessionId),
    catch: (cause) => new AnalysisPipelineError({ cause }),
  });

  const allQuestions = yield* Effect.tryPromise({
    try: () => getQuestionsBySessionId(sessionId),
    catch: (cause) => new AnalysisPipelineError({ cause }),
  });

  // Map to the shape the writers expect from MachineContext
  const answers: MachineContext["answers"] = allAnswers.map((a) => ({
    questionId: a.questionId,
    text: a.text,
    round: a.round,
  }));

  const questions: MachineContext["questions"] = allQuestions.map((q) => ({
    id: q.id,
    text: q.text,
    rationale: q.rationale,
    sourceDocuments: q.sourceDocuments,
  }));

  const outputVersion = actor.getSnapshot().context.outputVersion;

  // Run both writer passes (prompt caching applies across both — same summaries)
  const [briefText, prdText] = yield* Effect.all(
    [
      runBriefWriter(summaries, answers, questions).pipe(
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      ),
      runPrdWriter(summaries, answers, questions).pipe(
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      ),
    ],
    { concurrency: 2 },
  );

  // Store both outputs
  yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        createOutput({
          sessionId,
          type: "project_brief",
          content: briefText,
          version: outputVersion,
        }),
        createOutput({
          sessionId,
          type: "implementation_prd",
          content: prdText,
          version: outputVersion,
        }),
      ]),
    catch: (cause) => new AnalysisPipelineError({ cause }),
  });

  // Fire OUTPUT_READY — machine → complete
  actor.send({
    type: "OUTPUT_READY",
    outputs: {
      projectBrief: briefText,
      implementationPrd: prdText,
    },
  });
});
