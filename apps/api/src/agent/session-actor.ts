import { Array, Effect, pipe, Schema } from "effect";
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
import { DatabaseService, ReconstructedSummary } from "../db/queries.js";
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

  const session = yield* db.getAgentSesionById({ sessionId });

  if (!session) {
    return yield* new SessionNotFoundError();
  }

  const actor: AgentActor = yield* pipe(
    Effect.fromNullishOr(session.xstateSnapshot),
    Effect.as(restoreAgentActor(session.xstateSnapshot)),
    Effect.catchTag("NoSuchElementError", () => Effect.succeed(createAgentActor({ sessionId }))),
  );

  yield* wireSnapshotPersistence(actor, sessionId);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
});

// const _createAndRegisterActor = Effect.fnUntraced(function* (sessionId: string) {
//   const actor = createAgentActor({ sessionId });
//   yield* wireSnapshotPersistence(actor, sessionId);
//   actor.start();
//   registry.set(sessionId, actor);
//   return actor;
// });

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

export const runSessionWorkflow = Effect.fn("agent/runSessionWorkflow")(
  function* (sessionId: string) {
    const db = yield* DatabaseService;
    const actor = yield* getOrRestoreActor(sessionId);

    yield* summarizeAllDocuments(sessionId);

    const documentSummaries = yield* db.getFinalSummariesBySession(sessionId);
    actor.send({
      type: "SUMMARIZATION_DONE",
      documentSummaries: documentSummaries.map((summary) => ({
        id: summary.id,
        content: summary.summary,
        documentId: summary.documentId,
        sourceDocument: summary.sourceDocument,
        tokenCount: summary.tokenCount,
      })),
    });
    actor.send({
      type: "USER_CONFIRM",
    });

    const gapReport = yield* runChallenger(documentSummaries);
    const { questions: generatedQuestions } = yield* runQuestionGenerator(
      gapReport,
      documentSummaries,
    );
    const dbQuestions = yield* db.createQuestions(
      generatedQuestions.map((q, idx) => ({
        text: q.text,
        rationale: q.rationale,
        sourceDocuments: [...q.sourceDocuments], // TODO: Readonly string is not assignalbe to blah blah...
        sessionId: sessionId,
        orderIndex: idx + 1,
      })),
    );

    actor.send({
      type: "ANALYSIS_DONE",
      gapReport,
      questions: dbQuestions.map((q) => ({
        id: q.id,
        rationale: q.rationale,
        sourceDocuments: q.sourceDocuments,
        text: q.text,
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
      yield* pipe(
        runGeneratingPipeline(sessionId),
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

    const db = yield* DatabaseService;

    const processBrief = Effect.fnUntraced(function* (
      summaries: ReconstructedSummary[],
      answers: MachineContext["answers"],
      questions: MachineContext["questions"],
    ) {
      const storage = yield* StorageAdapter;
      const briefText = yield* pipe(
        runBriefWriter(summaries, answers, questions, sessionId),
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      );

      const briefKey = `outputs/${sessionId}/project_brief_v${outputVersion}.md`;
      yield* pipe(
        storage.upload(briefKey, Buffer.from(briefText, "utf-8")),
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      );

      yield* db.createOutput({
        sessionId,
        type: "project_brief",
        content: briefText,
        version: outputVersion,
        s3Key: briefKey,
      });
      return briefText;
    });

    const processPrd = Effect.fnUntraced(function* (
      summaries: ReconstructedSummary[],
      answers: MachineContext["answers"],
      questions: MachineContext["questions"],
    ) {
      const storage = yield* StorageAdapter;
      const prdText = yield* pipe(
        runPrdWriter(summaries, answers, questions, sessionId),
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      );

      const prdKey = `outputs/${sessionId}/implementation_prd_v${outputVersion}.md`;

      yield* pipe(
        storage.upload(prdKey, Buffer.from(prdText, "utf-8")),
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      );

      yield* db.createOutput({
        sessionId,
        type: "implementation_prd",
        content: prdText,
        version: outputVersion,
        s3Key: prdKey,
      });

      return prdText;
    });

    const actor = yield* getOrRestoreActor(sessionId);
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

    const [projectBrief, implementationPrd] = yield* Effect.all([
      processBrief(summaries, answers, questions),
      processPrd(summaries, answers, questions),
    ]);

    actor.send({ type: "OUTPUT_READY", outputs: { projectBrief, implementationPrd } });
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
    const existingPrdRow = yield* db.getLatestOutputByType({
      sessionId,
      type: "implementation_prd",
    });
    const existingBriefRow = yield* db.getLatestOutputByType({ sessionId, type: "project_brief" });

    const processBrief = Effect.fnUntraced(function* ({
      existingBrief,
      existingPrd,
    }: {
      existingBrief: string;
      existingPrd: string;
    }) {
      const feedback = actor.getSnapshot().context.revisionFeedback ?? "";
      const outputVersion = actor.getSnapshot().context.outputVersion;

      const newBriefText = yield* pipe(
        runRevisionBriefWriter(summaries, existingBrief, existingPrd, feedback, sessionId),
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      );

      const briefKey = `outputs/${sessionId}/project_brief_v${outputVersion}.md`;

      yield* pipe(
        storage.upload(briefKey, Buffer.from(newBriefText, "utf-8")),
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      );

      yield* db.createOutput({
        sessionId,
        type: "project_brief",
        content: newBriefText,
        version: outputVersion,
        s3Key: briefKey,
      });

      return newBriefText;
    });

    const processPrd = Effect.fnUntraced(function* ({
      existingBrief,
      existingPrd,
    }: {
      existingBrief: string;
      existingPrd: string;
    }) {
      const feedback = actor.getSnapshot().context.revisionFeedback ?? "";
      const outputVersion = actor.getSnapshot().context.outputVersion;

      const newPrdText = yield* pipe(
        runRevisionPrdWriter(summaries, existingBrief, existingPrd, feedback, sessionId),
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      );

      const prdKey = `outputs/${sessionId}/implementation_prd_v${outputVersion}.md`;

      yield* pipe(
        storage.upload(prdKey, Buffer.from(newPrdText, "utf-8")),
        Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
      );

      yield* db.createOutput({
        sessionId,
        type: "implementation_prd",
        content: newPrdText,
        version: outputVersion,
        s3Key: prdKey,
      });

      return newPrdText;
    });

    const [projectBrief, implementationPrd] = yield* Effect.all([
      processBrief({
        existingBrief: existingBriefRow?.content ?? "",
        existingPrd: existingPrdRow?.content ?? "",
      }),

      processPrd({
        existingBrief: existingBriefRow?.content ?? "",
        existingPrd: existingPrdRow?.content ?? "",
      }),
    ]);

    actor.send({ type: "OUTPUT_READY", outputs: { projectBrief, implementationPrd } });
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);
