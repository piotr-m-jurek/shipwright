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

import { Effect, pipe, Schema } from "effect";
import { StorageAdapter } from "../storage/index.js";
import { createAgentActor, restoreAgentActor, type AgentActor } from "./machine.js";
import { MachineContextSchema, type MachineContext } from "../shared/schemas/machine.js";
import { summarizeAllDocuments } from "./summarizer.js";
import { runChallenger } from "./challenger.js";
import { runQuestionGenerator } from "./question-generator.js";
import { runBriefWriter } from "./writer-brief.js";
import { runPrdWriter } from "./writer-prd.js";
import { runRevisionBriefWriter, runRevisionPrdWriter } from "./writer-revision.js";
import { DatabaseService } from "../db/queries.js";

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
  const db = yield* DatabaseService;
  const existing = registry.get(sessionId);
  if (existing) return existing;

  const session = yield* db.getAgentSesionById(sessionId);

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

  yield* wireSnapshotPersistence(actor, sessionId);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
});

/**
 * Create a fresh actor for a new session, register it, and start it.
 * Called after confirm-upload when the session is brand new.
 */
const createAndRegisterActor = Effect.fnUntraced(function* (sessionId: string) {
  const actor = createAgentActor({ sessionId });
  yield* wireSnapshotPersistence(actor, sessionId);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
});

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

const wireSnapshotPersistence = Effect.fnUntraced(function* wireSnapshotPersistence(
  actor: AgentActor,
  sessionId: string,
) {
  const db = yield* DatabaseService;
  const services = yield* Effect.context<never>();

  actor.subscribe((snapshot) => {
    const xstateState = snapshot.value as string;
    const dbStatus = ERROR_STATES.has(xstateState) ? "error" : xstateState;

    Effect.runForkWith(services)(
      db
        .updateAgentSessionSnapshot(sessionId, dbStatus as any, snapshot)
        .pipe(
          Effect.tapError((err) =>
            Effect.logError(
              `[session-actor] Failed to persist snapshot for ${sessionId} (state: ${xstateState}):`,
              err,
            ),
          ),
        ),
    );
  });
});

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
export const runAnalysisPipeline = Effect.fn("agent/runAnalysisPipeline")(
  function* (sessionId: string) {
    const db = yield* DatabaseService;
    const actor = yield* getOrRestoreActor(sessionId);

    yield* summarizeAllDocuments(sessionId);

    const summaries = yield* db.getFinalSummariesBySession(sessionId);
    const gapReport = yield* runChallenger(summaries);

    const persistedQuestions = yield* pipe(
      runQuestionGenerator(gapReport, summaries),
      Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      Effect.flatMap(({ questions: generatedQuestions }) =>
        db.createQuestions(
          generatedQuestions.map((q, i) => ({
            sessionId,
            text: q.text,
            rationale: q.rationale,
            sourceDocuments: q.sourceDocuments,
            orderIndex: i,
          })),
        ),
      ),
    );

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
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);

// ── Answer submission ──────────────────────────────────────────────────────

/**
 * Submit answers for the current clarifying round.
 * Persists answers to DB, fires USER_ANSWERED, then evaluates whether
 * answers are sufficient and fires ANSWERS_SUFFICIENT or ANSWERS_INSUFFICIENT.
 *
 * Sufficiency check: if all answers are non-empty and the round is >= 1,
 * treat as sufficient. The heuristic can be replaced with an LLM judge later.
 */
export const submitAnswers = Effect.fn("agent/submitAnswers")(
  function* (sessionId: string, rawAnswers: { questionId: string; text: string }[]) {
    const db = yield* DatabaseService;
    const actor = yield* getOrRestoreActor(sessionId);

    const state = actor.getSnapshot().value;
    if (state !== "awaiting_answers") {
      return yield* new SessionStateError({
        message: `Session ${sessionId} is in state '${state}', expected 'awaiting_answers'`,
      });
    }

    const round = actor.getSnapshot().context.round;

    // Persist answers to DB
    const persistedAnswers = yield* db.createAnswers(
      rawAnswers.map((a) => ({
        sessionId,
        questionId: a.questionId,
        text: a.text,
        round,
      })),
    );

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
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);

// ── Generating pipeline ────────────────────────────────────────────────────

/**
 * Run both writer passes (Brief + PRD), store in `outputs` table, fire OUTPUT_READY.
 * Invoked from the generating state — called after ANSWERS_SUFFICIENT or roundLimitReached.
 */
export const runGeneratingPipeline = Effect.fn("agent/runGeneratingPipeline")(
  function* (sessionId: string) {
    const actor = yield* getOrRestoreActor(sessionId);
    const db = yield* DatabaseService;

    const summaries = yield* db.getFinalSummariesBySession(sessionId);
    const allAnswers = yield* db.getAnswersBySessionId(sessionId);
    const allQuestions = yield* db.getQuestionsBySessionId(sessionId);

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

    // Upload both outputs to S3 for presigned URL export (Rule 4 — file I/O via StorageAdapter)
    const storage = yield* StorageAdapter;
    const briefKey = `outputs/${sessionId}/project_brief_v${outputVersion}.md`;
    const prdKey = `outputs/${sessionId}/implementation_prd_v${outputVersion}.md`;

    yield* Effect.all(
      [
        storage
          .upload(briefKey, Buffer.from(briefText, "utf-8"))
          .pipe(Effect.mapError((cause) => new AnalysisPipelineError({ cause }))),
        storage
          .upload(prdKey, Buffer.from(prdText, "utf-8"))
          .pipe(Effect.mapError((cause) => new AnalysisPipelineError({ cause }))),
      ],
      { concurrency: 2 },
    );

    // Store both outputs in DB with S3 key for download-url endpoint
    yield* Effect.all([
      db.createOutput({
        sessionId,
        type: "project_brief",
        content: briefText,
        version: outputVersion,
        s3Key: briefKey,
      }),
      db.createOutput({
        sessionId,
        type: "implementation_prd",
        content: prdText,
        version: outputVersion,
        s3Key: prdKey,
      }),
    ]);

    // Fire OUTPUT_READY — machine → complete
    actor.send({
      type: "OUTPUT_READY",
      outputs: {
        projectBrief: briefText,
        implementationPrd: prdText,
      },
    });
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);

// ── Revision ───────────────────────────────────────────────────────────────

/**
 * Fire REVISION_REQUESTED on the actor and fork the revision pipeline.
 */
export const startRevision = Effect.fn("agent/startRevision")(function* (
  sessionId: string,
  feedback: string,
) {
  const actor = yield* getOrRestoreActor(sessionId);

  const state = actor.getSnapshot().value as string;
  if (state !== "complete") {
    return yield* new SessionStateError({
      message: `Session ${sessionId} is in state '${state}', expected 'complete'`,
    });
  }

  actor.send({ type: "REVISION_REQUESTED", feedback });

  yield* runRevisionPipeline(sessionId).pipe(
    Effect.tapError((e) =>
      Effect.sync(() => console.error("[session-actor] revision pipeline error:", e)),
    ),
    Effect.forkDetach,
  );

  return { started: true };
});

/**
 * Run the revision pipeline: load existing outputs + summaries, re-run both
 * writers with feedback, store new version, fire OUTPUT_READY.
 */
export const runRevisionPipeline = Effect.fn("agent/runRevisionPipeline")(
  function* (sessionId: string) {
    const actor = yield* getOrRestoreActor(sessionId);
    const storage = yield* StorageAdapter;
    const db = yield* DatabaseService;

    const summaries = yield* db.getFinalSummariesBySession(sessionId);

    const [existingBriefRow, existingPrdRow] = yield* Effect.all(
      [
        db.getLatestOutputByType(sessionId, "project_brief"),
        db.getLatestOutputByType(sessionId, "implementation_prd"),
      ],
      { concurrency: "unbounded" },
    );

    const existingBrief = existingBriefRow?.content ?? "";
    const existingPrd = existingPrdRow?.content ?? "";

    const feedback = actor.getSnapshot().context.revisionFeedback ?? "";
    const outputVersion = actor.getSnapshot().context.outputVersion;

    const [newBriefText, newPrdText] = yield* Effect.all(
      [
        runRevisionBriefWriter(summaries, existingBrief, existingPrd, feedback).pipe(
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        ),
        runRevisionPrdWriter(summaries, existingBrief, existingPrd, feedback).pipe(
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        ),
      ],
      { concurrency: 2 },
    );

    const briefKey = `outputs/${sessionId}/project_brief_v${outputVersion}.md`;
    const prdKey = `outputs/${sessionId}/implementation_prd_v${outputVersion}.md`;

    yield* Effect.all(
      [
        storage
          .upload(briefKey, Buffer.from(newBriefText, "utf-8"))
          .pipe(Effect.mapError((cause) => new AnalysisPipelineError({ cause }))),
        storage
          .upload(prdKey, Buffer.from(newPrdText, "utf-8"))
          .pipe(Effect.mapError((cause) => new AnalysisPipelineError({ cause }))),
      ],
      { concurrency: 2 },
    );

    yield* Effect.all(
      [
        db.createOutput({
          sessionId,
          type: "project_brief",
          content: newBriefText,
          version: outputVersion,
          s3Key: briefKey,
        }),
        db.createOutput({
          sessionId,
          type: "implementation_prd",
          content: newPrdText,
          version: outputVersion,
          s3Key: prdKey,
        }),
      ],
      { concurrency: "unbounded" },
    );

    actor.send({
      type: "OUTPUT_READY",
      outputs: { projectBrief: newBriefText, implementationPrd: newPrdText },
    });
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);
