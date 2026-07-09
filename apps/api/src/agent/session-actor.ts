import { Effect, pipe, Schema } from "effect";
import { StorageAdapter } from "../storage/index.js";
import { createAgentActor, restoreAgentActor, type AgentActor } from "./machine.js";
import {
  MachineContextEffectSchema,
  type MachineContext,
} from "@shipwright/shared/schemas/machine.js";
import { summarizeAllDocuments } from "./summarizer.js";
import { runChallenger } from "./challenger.js";
import { runQuestionGenerator } from "./question-generator.js";
import { runBriefWriter } from "./writer-brief.js";
import { runPrdWriter } from "./writer-prd.js";
import { runRevisionBriefWriter, runRevisionPrdWriter } from "./writer-revision.js";
import { DatabaseService } from "../db/queries.js";
import { Spans } from "../observability/spans.js";

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

const registry = new Map<string, AgentActor>();

// XState states that map to the 'error' value in the Postgres session_status enum.
const ERROR_STATES = new Set([
  "uploading_error",
  "processing_error",
  "analyzing_error",
  "re_evaluating_error",
  "generating_error",
  "revising_error",
]);

export const getOrRestoreActor = Effect.fn("agent/getOrRestoreActor")(function* (
  sessionId: string,
) {
  const db = yield* DatabaseService;
  const existing = registry.get(sessionId);

  if (existing) {
    return existing;
  }

  const session = yield* db.getAgentSesionById(sessionId);

  if (!session) {
    return yield* new SessionNotFoundError();
  }

  const actor: AgentActor = yield* pipe(
    Effect.fromNullishOr(session.xstateSnapshot),
    Effect.flatMap((snapshot) =>
      Schema.decodeUnknownEffect(MachineContextEffectSchema)((snapshot as any)?.context),
    ),
    Effect.as(restoreAgentActor(session.xstateSnapshot)),
    Effect.catchTag("NoSuchElementError", () => Effect.succeed(createAgentActor({ sessionId }))),
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new SessionStateError({ message: `Corrupt xstateSnapshot for session ${sessionId}` }),
      ),
    ),
  );

  yield* wireSnapshotPersistence(actor, sessionId);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
});

const createAndRegisterActor = Effect.fnUntraced(function* (sessionId: string) {
  const actor = createAgentActor({ sessionId });
  yield* wireSnapshotPersistence(actor, sessionId);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
});

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

export const runAnalysisPipeline = Effect.fn("agent/runAnalysisPipeline")(
  function* (sessionId: string) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

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
          [...generatedQuestions].map((q, i) => ({
            sessionId,
            text: q.text,
            rationale: q.rationale,
            sourceDocuments: [...q.sourceDocuments],
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

export const submitAnswers = Effect.fn("agent/submitAnswers")(
  function* (sessionId: string, rawAnswers: { questionId: string; text: string }[]) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

    const db = yield* DatabaseService;
    const actor = yield* getOrRestoreActor(sessionId);

    const state = actor.getSnapshot().value;
    if (state !== "awaiting_answers") {
      return yield* new SessionStateError({
        message: `Session ${sessionId} is in state '${state}', expected 'awaiting_answers'`,
      });
    }

    const round = actor.getSnapshot().context.round;

    const persistedAnswers = yield* db.createAnswers(
      rawAnswers.map((a) => ({
        sessionId,
        questionId: a.questionId,
        text: a.text,
        round,
      })),
    );

    actor.send({
      type: "USER_ANSWERED",
      answers: persistedAnswers.map((a) => ({
        questionId: a.questionId,
        text: a.text,
        round: a.round,
      })),
    });

    // Sufficiency heuristic: all answers non-empty and at least one full round completed.
    const allAnswered = rawAnswers.every((a) => a.text.trim().length > 0);
    const sufficient = allAnswered && round >= 1;

    const currentQuestions = actor.getSnapshot().context.questions;

    if (sufficient) {
      actor.send({ type: "ANSWERS_SUFFICIENT", questions: currentQuestions });
    } else {
      actor.send({ type: "ANSWERS_INSUFFICIENT", questions: currentQuestions });
    }

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

export const runGeneratingPipeline = Effect.fn("agent/runGeneratingPipeline")(
  function* (sessionId: string) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

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

export const startRevision = Effect.fn("agent/startRevision")(function* (
  sessionId: string,
  feedback: string,
) {
  yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

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

export const runRevisionPipeline = Effect.fn("agent/runRevisionPipeline")(
  function* (sessionId: string) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

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
