import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { Effect, Option, pipe } from "effect";
import { Spans } from "../../observability/spans";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import type { DocumentSummary } from "@shipwright/shared/domain/types";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { StorageAdapter } from "../../storage/index";
import { runBriefWriter, runPrdWriter, runRevisionBriefWriter, runRevisionPrdWriter } from "../writer/index";
import { getOrRestoreActor } from "../session-actor";
import { AnalysisPipelineError, SessionStateError } from "../errors";
import type { MachineContext } from "@shipwright/shared/schemas/machine";
import { MessageQueue } from "../../queue/index";

export const runGeneratingPipeline = Effect.fn("agent/runGeneratingPipeline")(
  function* (sessionId: AgentSessionId) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

    const summaryDb = yield* SummaryRepository;
    const clarificationDb = yield* ClarificationRepository;
    const outputDb = yield* OutputRepository;
    const storage = yield* StorageAdapter;

    const processBrief = Effect.fn("agent/generateBrief")(function* (
      summaries: DocumentSummary[],
      answers: MachineContext["answers"],
      questions: MachineContext["questions"],
    ) {
      return yield* Effect.gen(function* () {
        const briefText = yield* pipe(
          runBriefWriter(summaries, answers, questions, sessionId),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );

        yield* Effect.logInfo(`[generation] brief written — ${briefText.length} chars`).pipe(
          Effect.annotateLogs({ sessionId, outputVersion, chars: briefText.length }),
        );

        const briefKey = `outputs/${sessionId}/project_brief_v${outputVersion}.md`;
        yield* pipe(
          storage.upload(briefKey, Buffer.from(briefText, "utf-8")),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );
        yield* Effect.logInfo("[generation] brief uploaded to storage").pipe(
          Effect.annotateLogs({ sessionId, briefKey }),
        );

        yield* outputDb.createOutput({
          sessionId,
          type: "project_brief",
          content: briefText,
          version: outputVersion,
          s3Key: briefKey,
        });
        yield* Effect.logInfo("[generation] brief persisted to DB").pipe(
          Effect.annotateLogs({ sessionId, outputVersion }),
        );
        return briefText;
      }).pipe(
        Effect.withSpan("agent/generate-brief", {
          attributes: { "shipwright.session.id": sessionId },
        }),
      );
    });

    const processPrd = Effect.fn("agent/generatePrd")(function* (
      summaries: DocumentSummary[],
      answers: MachineContext["answers"],
      questions: MachineContext["questions"],
    ) {
      return yield* Effect.gen(function* () {
        const prdText = yield* pipe(
          runPrdWriter(summaries, answers, questions, sessionId),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );

        yield* Effect.logInfo(`[generation] PRD written — ${prdText.length} chars`).pipe(
          Effect.annotateLogs({ sessionId, outputVersion, chars: prdText.length }),
        );

        const prdKey = `outputs/${sessionId}/implementation_prd_v${outputVersion}.md`;
        yield* pipe(
          storage.upload(prdKey, Buffer.from(prdText, "utf-8")),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );
        yield* Effect.logInfo("[generation] PRD uploaded to storage").pipe(
          Effect.annotateLogs({ sessionId, prdKey }),
        );

        yield* outputDb.createOutput({
          sessionId,
          type: "implementation_prd",
          content: prdText,
          version: outputVersion,
          s3Key: prdKey,
        });
        yield* Effect.logInfo("[generation] PRD persisted to DB").pipe(
          Effect.annotateLogs({ sessionId, outputVersion }),
        );
        return prdText;
      }).pipe(
        Effect.withSpan("agent/generate-prd", {
          attributes: { "shipwright.session.id": sessionId },
        }),
      );
    });

    const actor = yield* getOrRestoreActor(sessionId);
    const summaries = yield* summaryDb.getFinalSummariesBySession(sessionId);
    const allAnswers = yield* clarificationDb.getAnswersBySessionId(sessionId);
    const allQuestions = yield* clarificationDb.getQuestionsBySessionId(sessionId);

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

export const runRevisionPipeline = Effect.fn("agent/runRevisionPipeline")(
  function* (sessionId: AgentSessionId) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

    const actor = yield* getOrRestoreActor(sessionId);
    const storage = yield* StorageAdapter;
    const summaryDb = yield* SummaryRepository;
    const outputDb = yield* OutputRepository;

    const summaries = yield* summaryDb.getFinalSummariesBySession(sessionId);
    const existingPrdContent = yield* outputDb
      .getLatestOutputByType({ sessionId, type: "implementation_prd" })
      .pipe(
        Effect.map(Option.flatMapNullishOr((r) => r.content)),
        Effect.map(Option.getOrElse(() => "")),
      );
    const existingBriefContent = yield* outputDb
      .getLatestOutputByType({
        sessionId,
        type: "project_brief",
      })
      .pipe(
        Effect.map(Option.flatMapNullishOr((r) => r.content)),
        Effect.map(Option.getOrElse(() => "")),
      );

    const processBrief = Effect.fn("agent/reviseBrief")(function* ({
      existingBrief,
      existingPrd,
    }: {
      existingBrief: string;
      existingPrd: string;
    }) {
      return yield* Effect.gen(function* () {
        const feedback = Option.getOrElse(actor.getSnapshot().context.revisionFeedback, () => "");
        const outputVersion = actor.getSnapshot().context.outputVersion;

        const newBriefText = yield* pipe(
          runRevisionBriefWriter(summaries, existingBrief, existingPrd, feedback, sessionId),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );

        yield* Effect.logInfo(`[revision] brief written — ${newBriefText.length} chars`).pipe(
          Effect.annotateLogs({ sessionId, outputVersion, chars: newBriefText.length }),
        );

        const briefKey = `outputs/${sessionId}/project_brief_v${outputVersion}.md`;
        yield* pipe(
          storage.upload(briefKey, Buffer.from(newBriefText, "utf-8")),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );
        yield* Effect.logInfo("[revision] brief uploaded").pipe(
          Effect.annotateLogs({ sessionId, briefKey }),
        );

        yield* outputDb.createOutput({
          sessionId,
          type: "project_brief",
          content: newBriefText,
          version: outputVersion,
          s3Key: briefKey,
        });
        yield* Effect.logInfo("[revision] brief persisted to DB").pipe(
          Effect.annotateLogs({ sessionId, outputVersion }),
        );
        return newBriefText;
      }).pipe(
        Effect.withSpan("agent/revise-brief", {
          attributes: { "shipwright.session.id": sessionId },
        }),
      );
    });

    const processPrd = Effect.fn("agent/revisePrd")(function* ({
      existingBrief,
      existingPrd,
    }: {
      existingBrief: string;
      existingPrd: string;
    }) {
      return yield* Effect.gen(function* () {
        const feedback = Option.getOrElse(actor.getSnapshot().context.revisionFeedback, () => "");
        const outputVersion = actor.getSnapshot().context.outputVersion;

        const newPrdText = yield* pipe(
          runRevisionPrdWriter(summaries, existingBrief, existingPrd, feedback, sessionId),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );

        yield* Effect.logInfo(`[revision] PRD written — ${newPrdText.length} chars`).pipe(
          Effect.annotateLogs({ sessionId, outputVersion, chars: newPrdText.length }),
        );

        const prdKey = `outputs/${sessionId}/implementation_prd_v${outputVersion}.md`;
        yield* pipe(
          storage.upload(prdKey, Buffer.from(newPrdText, "utf-8")),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );
        yield* Effect.logInfo("[revision] PRD uploaded").pipe(
          Effect.annotateLogs({ sessionId, prdKey }),
        );

        yield* outputDb.createOutput({
          sessionId,
          type: "implementation_prd",
          content: newPrdText,
          version: outputVersion,
          s3Key: prdKey,
        });
        yield* Effect.logInfo("[revision] PRD persisted to DB").pipe(
          Effect.annotateLogs({ sessionId, outputVersion }),
        );
        return newPrdText;
      }).pipe(
        Effect.withSpan("agent/revise-prd", {
          attributes: { "shipwright.session.id": sessionId },
        }),
      );
    });

    const [projectBrief, implementationPrd] = yield* Effect.all([
      processBrief({
        existingBrief: existingBriefContent,
        existingPrd: existingPrdContent,
      }),

      processPrd({
        existingBrief: existingBriefContent,
        existingPrd: existingPrdContent,
      }),
    ]);

    actor.send({ type: "OUTPUT_READY", outputs: { projectBrief, implementationPrd } });
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);

export const startRevision = Effect.fn("agent/startRevision")(function* (
  sessionId: AgentSessionId,
  feedback: string,
) {
  yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

  const mq = yield* MessageQueue;
  const actor = yield* getOrRestoreActor(sessionId);

  const state = actor.getSnapshot().value as string;
  if (state !== "complete") {
    return yield* new SessionStateError({
      message: `Session ${sessionId} is in state '${state}', expected 'complete'`,
    });
  }

  actor.send({ type: "REVISION_REQUESTED", feedback });
  yield* mq.publish("session.revise", { sessionId });

  return { started: true };
});
