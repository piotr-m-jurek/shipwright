import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { Effect, Exit } from "effect";
import { DbSummary } from "../../db/services/summary.ts";
import { DbClarification } from "../../db/services/clarification.ts";
import { getOrRestoreActor } from "../session-actor.js";
import { summarizeAllDocuments } from "../writers/summarizer.js";
import { runChallenger } from "../writers/challenger.js";
import { runQuestionGenerator } from "../writers/question-generator.js";
import { AnalysisPipelineError } from "../errors.js";
import { Spans } from "../../observability/spans.ts";
import { DbAgentSession } from "../../db/services/agent-session.ts";

const runSessionWorkflowInner = Effect.fn("agent/runSessionWorkflow")(function* (
  sessionId: AgentSessionId,
) {
  yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

  const summaryDb = yield* DbSummary;
  const clarificationDb = yield* DbClarification;
  const actor = yield* getOrRestoreActor(sessionId);

  yield* summarizeAllDocuments(sessionId);

  const documentSummaries = yield* summaryDb.getFinalSummariesBySession(sessionId);
  yield* Effect.logInfo(`[runSessionWorkflow] summarization done — ${documentSummaries.length} summaries`).pipe(
    Effect.annotateLogs({ sessionId, summaryCount: documentSummaries.length }),
  );
  yield* Effect.annotateCurrentSpan({ "shipwright.summary.count": documentSummaries.length });

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
  yield* Effect.logInfo("[runSessionWorkflow] sent SUMMARIZATION_DONE").pipe(
    Effect.annotateLogs({ sessionId }),
  );

  actor.send({ type: "USER_CONFIRM" });
  yield* Effect.logInfo("[runSessionWorkflow] sent USER_CONFIRM").pipe(
    Effect.annotateLogs({ sessionId }),
  );

  const gapReport = yield* runChallenger(documentSummaries);
  yield* Effect.logInfo(`[runSessionWorkflow] challenger done — ${gapReport.conflicts.length} conflicts, ${gapReport.gaps.length} gaps, ${gapReport.ambiguities.length} ambiguities`).pipe(
    Effect.annotateLogs({ sessionId }),
  );

  const { questions: generatedQuestions } = yield* runQuestionGenerator(
    gapReport,
    documentSummaries,
  );
  yield* Effect.logInfo(`[runSessionWorkflow] question generator done — ${generatedQuestions.length} questions`).pipe(
    Effect.annotateLogs({ sessionId, questionCount: generatedQuestions.length }),
  );

  const dbQuestions = yield* clarificationDb.createQuestions(
    generatedQuestions.map((q, idx) => ({
      text: q.text,
      rationale: q.rationale,
      sourceDocuments: [...q.sourceDocuments], // TODO: Readonly string is not assignalbe to blah blah...
      sessionId: sessionId,
      orderIndex: idx + 1,
    })),
  );
  yield* Effect.annotateCurrentSpan({ "shipwright.question.count": dbQuestions.length });

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
  yield* Effect.logInfo("[runSessionWorkflow] sent ANALYSIS_DONE").pipe(
    Effect.annotateLogs({ sessionId, questionCount: dbQuestions.length }),
  );
});

export const runSessionWorkflow = (sessionId: AgentSessionId) =>
  runSessionWorkflowInner(sessionId).pipe(
    Effect.tapCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError("[runSessionWorkflow] analysis pipeline failed").pipe(
          Effect.annotateLogs({ sessionId }),
          Effect.andThen(Effect.logError(cause)),
          Effect.andThen(Effect.annotateCurrentSpan({ "error": true })),
        );
        // Drive the actor into its error state so the session-actor subscriber
        // persists the status as "error" in the DB. Without this the session
        // stays in "summarizing" indefinitely after all retries are exhausted.
        const actorResult = yield* Effect.exit(getOrRestoreActor(sessionId));
        if (Exit.isSuccess(actorResult)) {
          actorResult.value.send({ type: "ERROR", cause });
        } else {
          // Actor unavailable — write error status directly to DB as fallback.
          const agentSessionDb = yield* DbAgentSession;
          yield* agentSessionDb.updateAgentSession(sessionId, "error");
        }
      }),
    ),
    Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
  );
