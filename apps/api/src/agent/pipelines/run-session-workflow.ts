import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { Clock, Effect, Exit, Metric, Option } from "effect";
import { waitFor } from "xstate";
import { sessionErrorCounter, pipelineDurationHistogram } from "../../observability/metrics";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { getOrRestoreActor } from "../session-actor";
import { isSummarizingError } from "../session-process-manager";
import { runChallenger, runQuestionGenerator } from "../challenger/index";
import { AnalysisPipelineError, AllExtractionsFailedError } from "../errors";
import { Spans } from "@shipwright/observability";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";

const runSessionWorkflowInner = Effect.fn("agent/runSessionWorkflow")(function* (
  sessionId: AgentSessionId,
) {
  yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

  const summaryDb = yield* SummaryRepository;
  const clarificationDb = yield* ClarificationRepository;
  const documentDb = yield* DocumentRepository;
  const actor = yield* getOrRestoreActor(sessionId);

  // ── Parallel extraction ──────────────────────────────────────────────────
  // Fetch documents for this session (DB concern — stays out of machine context).
  const docs = yield* documentDb.getDocumentsBySessionId(sessionId);

  // Hand off to the machine: EXTRACTION_STARTED spawns one summarizeDocumentActor
  // per document (see machine.ts's spawnDocumentActors / summarizeDocumentActor).
  // documentId travels in the event only — the machine never stores it in context.
  actor.send({
    type: "EXTRACTION_STARTED",
    documents: docs.map((d) => ({ filename: d.filename, documentId: d.id })),
  });
  yield* Effect.logInfo(`[runSessionWorkflow] extraction started — ${docs.length} documents`).pipe(
    Effect.annotateLogs({ sessionId, documentCount: docs.length }),
  );

  // Wait for the machine to settle all spawned actors. A failing document does
  // NOT abort siblings — that isolation now lives in the machine (each spawned
  // actor is independent), not in an Effect.forEach here.
  // NOTE: no timeout — a hung document actor blocks this indefinitely, same
  // risk profile as the previous Effect.forEach (no regression, not yet fixed).
  yield* Effect.promise(() =>
    waitFor(actor, (snapshot) => snapshot.matches("processing") || snapshot.matches("summarizing_error")),
  );

  // All actors settled. Check if machine transitioned to summarizing_error (all failed).
  if (isSummarizingError(actor.getSnapshot().value)) {
    return yield* new AllExtractionsFailedError();
  }

  // Fetch final summaries from DB and send SUMMARIZATION_DONE.
  const documentSummaries = yield* summaryDb.getFinalSummariesBySession(sessionId);
  yield* Effect.logInfo(
    `[runSessionWorkflow] summarization done — ${documentSummaries.length} summaries`,
  ).pipe(Effect.annotateLogs({ sessionId, summaryCount: documentSummaries.length }));
  yield* Effect.annotateCurrentSpan({ "shipwright.summary.count": documentSummaries.length });

  actor.send({
    type: "SUMMARIZATION_DONE",
    documentSummaries: documentSummaries.map((summary) => ({
      id: summary.id,
      content: summary.summary,
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
  yield* Effect.logInfo(
    `[runSessionWorkflow] challenger done — ${gapReport.conflicts.length} conflicts, ${gapReport.gaps.length} gaps, ${gapReport.ambiguities.length} ambiguities`,
  ).pipe(Effect.annotateLogs({ sessionId }));

  const { questions: generatedQuestions } = yield* runQuestionGenerator(
    gapReport,
    documentSummaries,
  );
  yield* Effect.logInfo(
    `[runSessionWorkflow] question generator done — ${generatedQuestions.length} questions`,
  ).pipe(Effect.annotateLogs({ sessionId, questionCount: generatedQuestions.length }));

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
    gapReport: Option.some(gapReport),
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
  Effect.gen(function* () {
    const startMs = yield* Clock.currentTimeMillis;
    const result = yield* Effect.exit(runSessionWorkflowInner(sessionId));
    const durationMs = (yield* Clock.currentTimeMillis) - startMs;
    yield* Metric.update(pipelineDurationHistogram, durationMs);

    if (Exit.isFailure(result)) {
      yield* Metric.update(sessionErrorCounter, 1);
      yield* Effect.gen(function* () {
        const cause = result.cause;
        yield* Effect.logError("[runSessionWorkflow] analysis pipeline failed").pipe(
          Effect.annotateLogs({ sessionId }),
          Effect.andThen(Effect.logError(cause)),
          Effect.andThen(Effect.annotateCurrentSpan({ error: true })),
        );
        // Drive the actor into its error state so the session-actor subscriber
        // persists the status as "error" in the DB. Without this the session
        // stays in "summarizing" indefinitely after all retries are exhausted.
        const actorResult = yield* Effect.exit(getOrRestoreActor(sessionId));
        if (Exit.isSuccess(actorResult)) {
          actorResult.value.send({ type: "ERROR", cause });
        } else {
          // Actor unavailable — write error status directly to DB as fallback.
          const agentSessionDb = yield* AgentSessionRepository;
          yield* agentSessionDb.updateAgentSession(sessionId, "error");
        }
      });
      return yield* result;
    }
    return result.value;
  }).pipe(Effect.mapError((cause) => new AnalysisPipelineError({ cause })));
