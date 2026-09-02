import { Effect, Layer } from "effect";
import { DocumentsProcess, SessionWorkflow, SessionGenerate, SessionRevise } from "@shipwright/queue";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { runSessionWorkflow } from "../agent/pipelines/run-session-workflow";
import { processUploadedDocuments } from "../agent/pipelines/process-uploaded-documents";
import { runGeneratingPipeline, runRevisionPipeline } from "../agent/pipelines/generation";
import { Spans } from "@shipwright/observability";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a job handler in a named span and logs any cause (typed error or
 * defect) before re-throwing, then converts the failure to a defect —
 * effect-mq's own attempts/backoff decide retry vs terminal failure from
 * there, the same way MessageQueue's auto-nack used to, regardless of
 * whether the pipeline failed with a typed error or a defect.
 *
 * Using Effect.withSpan means every queue job appears as a root trace in
 * Langfuse with the sessionId attached, making it trivial to correlate a
 * failed job to a session — nested inside effect-mq's own per-run span,
 * which adds jobId/queue/attempt and links back to the producer's trace.
 */
function withJobSpan<A, E, R>(
  spanName: string,
  sessionId: AgentSessionId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, never, R> {
  return effect.pipe(
    Effect.tapCause((cause) =>
      Effect.logError(`[${spanName}] job failed`).pipe(
        Effect.annotateLogs({ spanName, sessionId }),
        Effect.andThen(Effect.logError(cause)),
      ),
    ),
    Effect.orDie,
    // Propagate session ID to every child span so Langfuse can filter/group
    // all observations within a pipeline run by session.
    Effect.annotateSpans(Spans.session(sessionId)),
    Effect.withSpan(spanName, { attributes: Spans.session(sessionId) }),
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const JobHandlersLayer = Layer.mergeAll(
  DocumentsProcess.toLayer(({ sessionId, uploads }) =>
    withJobSpan("queue/documents.process", sessionId, processUploadedDocuments({ sessionId, uploads })),
  ),
  SessionWorkflow.toLayer(({ sessionId }) =>
    withJobSpan("queue/session.workflow", sessionId, runSessionWorkflow(sessionId)),
  ),
  SessionGenerate.toLayer(({ sessionId }) =>
    withJobSpan("queue/session.generate", sessionId, runGeneratingPipeline(sessionId)),
  ),
  SessionRevise.toLayer(({ sessionId }) =>
    withJobSpan("queue/session.revise", sessionId, runRevisionPipeline(sessionId)),
  ),
);
