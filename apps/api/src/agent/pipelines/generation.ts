import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { Effect, Option, pipe } from "effect";
import { Spans } from "@shipwright/observability";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import type { DocumentSummary } from "@shipwright/shared/domain/types";
import { outputStorageKey } from "@shipwright/shared/domain/storage-keys";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { StorageAdapter } from "@shipwright/storage";
import { runBriefWriter, runPrdWriter, runRevisionBriefWriter, runRevisionPrdWriter } from "../writer/index";
import { getOrRestoreActor } from "../session-actor";
import { AgentSessionAggregate } from "../agent-session-aggregate";
import { AnalysisPipelineError } from "../errors";
import type { MachineContext } from "@shipwright/shared/schemas/machine";
import { publishForCurrentState } from "../session-process-manager";

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

        const briefKey = outputStorageKey(sessionId, "project_brief", outputVersion);
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
          attributes: Spans.session(sessionId),
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

        const prdKey = outputStorageKey(sessionId, "implementation_prd", outputVersion);
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
          attributes: Spans.session(sessionId),
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

    // SHIP-149: outputVersion derived from the outputs table (single source
    // of truth) rather than the XState snapshot — a corrupted/rolled-back
    // snapshot could no longer diverge from what's actually persisted.
    const existingOutputs = yield* outputDb.getOutputsBySessionId(sessionId);
    const outputVersion = (existingOutputs[0]?.version ?? 0) + 1;

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

    // SHIP-149: outputVersion derived from the outputs table (single source
    // of truth) rather than the XState snapshot — computed once, both
    // passes below close over it, same version for brief and PRD.
    const existingOutputs = yield* outputDb.getOutputsBySessionId(sessionId);
    const outputVersion = (existingOutputs[0]?.version ?? 0) + 1;

    const processBrief = Effect.fn("agent/reviseBrief")(function* ({
      existingBrief,
      existingPrd,
    }: {
      existingBrief: string;
      existingPrd: string;
    }) {
      return yield* Effect.gen(function* () {
        const feedback = Option.getOrElse(actor.getSnapshot().context.revisionFeedback, () => "");

        const newBriefText = yield* pipe(
          runRevisionBriefWriter(summaries, existingBrief, existingPrd, feedback, sessionId),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );

        yield* Effect.logInfo(`[revision] brief written — ${newBriefText.length} chars`).pipe(
          Effect.annotateLogs({ sessionId, outputVersion, chars: newBriefText.length }),
        );

        const briefKey = outputStorageKey(sessionId, "project_brief", outputVersion);
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
          attributes: Spans.session(sessionId),
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

        const newPrdText = yield* pipe(
          runRevisionPrdWriter(summaries, existingBrief, existingPrd, feedback, sessionId),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );

        yield* Effect.logInfo(`[revision] PRD written — ${newPrdText.length} chars`).pipe(
          Effect.annotateLogs({ sessionId, outputVersion, chars: newPrdText.length }),
        );

        const prdKey = outputStorageKey(sessionId, "implementation_prd", outputVersion);
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
          attributes: Spans.session(sessionId),
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

  const aggregate = yield* AgentSessionAggregate;
  const stateAfter = yield* aggregate.requestRevision(sessionId, feedback);
  yield* publishForCurrentState(sessionId, stateAfter);

  return { started: true };
});
