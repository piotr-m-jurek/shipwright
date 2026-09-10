import type { AgentSessionId, DocumentId } from "@shipwright/shared/domain/ids";
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

type ExtractionKickoff =
  | { type: "EXTRACTION_STARTED"; documents: { filename: string; documentId: DocumentId }[] }
  | { type: "DOCUMENT_ADDED"; documents: { filename: string; documentId: DocumentId }[] };

// Shared by the initial pipeline (all of a session's documents, fired from
// `uploading`/`waiting_for_documents`) and SHIP-179/181's document-added
// pipeline (a single document, fired from `complete`). Both land the actor
// in the same place — `summarizing` — via different entry events, and
// everything from there on (processing/analyzing/questions) is identical:
// getFinalSummariesBySession is session-scoped, not document-scoped, so it
// naturally returns the full merged set once the new document's summary row
// exists — no manual merge step needed.
const runAnalysisWorkflowInner = Effect.fn("agent/runAnalysisWorkflow")(function* (
  sessionId: AgentSessionId,
  extractionKickoff: ExtractionKickoff,
) {
  yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

  const summaryDb = yield* SummaryRepository;
  const clarificationDb = yield* ClarificationRepository;
  const actor = yield* getOrRestoreActor(sessionId);

  // ── Parallel extraction ──────────────────────────────────────────────────
  // Hand off to the machine: EXTRACTION_STARTED/DOCUMENT_ADDED spawns one
  // summarizeDocumentActor per document (see machine.ts's spawnDocumentActors
  // / summarizeDocumentActor). documentId travels in the event only — the
  // machine never stores it in context.
  actor.send(extractionKickoff);
  yield* Effect.logInfo(
    `[runAnalysisWorkflow] ${extractionKickoff.type} — ${extractionKickoff.documents.length} document(s)`,
  ).pipe(
    Effect.annotateLogs({ sessionId, documentCount: extractionKickoff.documents.length }),
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
    `[runAnalysisWorkflow] summarization done — ${documentSummaries.length} summaries`,
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
  yield* Effect.logInfo("[runAnalysisWorkflow] sent SUMMARIZATION_DONE").pipe(
    Effect.annotateLogs({ sessionId }),
  );

  actor.send({ type: "USER_CONFIRM" });
  yield* Effect.logInfo("[runAnalysisWorkflow] sent USER_CONFIRM").pipe(
    Effect.annotateLogs({ sessionId }),
  );

  const gapReport = yield* runChallenger(documentSummaries);
  yield* Effect.logInfo(
    `[runAnalysisWorkflow] challenger done — ${gapReport.conflicts.length} conflicts, ${gapReport.gaps.length} gaps, ${gapReport.ambiguities.length} ambiguities`,
  ).pipe(Effect.annotateLogs({ sessionId }));

  const { questions: generatedQuestions } = yield* runQuestionGenerator(
    gapReport,
    documentSummaries,
  );
  yield* Effect.logInfo(
    `[runAnalysisWorkflow] question generator done — ${generatedQuestions.length} questions`,
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
  yield* Effect.logInfo("[runAnalysisWorkflow] sent ANALYSIS_DONE").pipe(
    Effect.annotateLogs({ sessionId, questionCount: dbQuestions.length }),
  );
});

const runAnalysisWorkflow = (sessionId: AgentSessionId, extractionKickoff: ExtractionKickoff) =>
  Effect.gen(function* () {
    const startMs = yield* Clock.currentTimeMillis;
    const result = yield* Effect.exit(runAnalysisWorkflowInner(sessionId, extractionKickoff));
    const durationMs = (yield* Clock.currentTimeMillis) - startMs;
    yield* Metric.update(pipelineDurationHistogram, durationMs);

    if (Exit.isFailure(result)) {
      yield* Metric.update(sessionErrorCounter, 1);
      yield* Effect.gen(function* () {
        const cause = result.cause;
        yield* Effect.logError("[runAnalysisWorkflow] analysis pipeline failed").pipe(
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

/** Initial pipeline — extracts/summarizes every document uploaded to the session. */
export const runSessionWorkflow = (sessionId: AgentSessionId) =>
  Effect.gen(function* () {
    const documentDb = yield* DocumentRepository;
    const docs = yield* documentDb.getDocumentsBySessionId(sessionId);
    return yield* runAnalysisWorkflow(sessionId, {
      type: "EXTRACTION_STARTED",
      documents: docs.map((d) => ({ filename: d.filename, documentId: d.id })),
    });
  });

/**
 * SHIP-179/181 — a single document added to an already-`complete` session.
 * Takes just the documentId (mirrors runSessionWorkflow fetching filenames
 * from DB rather than trusting a caller-supplied value) — reuses the exact
 * same downstream chain as runSessionWorkflow (processing → analyzing →
 * questions); getFinalSummariesBySession is session-scoped, so it picks up
 * the new document's summary alongside every existing one with no merge
 * step required.
 */
export const runDocumentAddedWorkflow = (sessionId: AgentSessionId, documentId: DocumentId) =>
  Effect.gen(function* () {
    const documentDb = yield* DocumentRepository;
    const document = yield* documentDb.getDocumentById(documentId).pipe(Effect.flatMap(Effect.fromOption));
    return yield* runAnalysisWorkflow(sessionId, {
      type: "DOCUMENT_ADDED",
      documents: [{ filename: document.filename, documentId: document.id }],
    });
  });
