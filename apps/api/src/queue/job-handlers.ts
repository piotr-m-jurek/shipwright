import { Context, Effect, Layer, Schema } from "effect";
import { Delivery, MessageQueue } from "@shipwright/queue";
import { AgentSessionId } from "@shipwright/shared/domain/ids";
import { runSessionWorkflow } from "../agent/pipelines/run-session-workflow";
import { processUploadedDocuments } from "../agent/pipelines/process-uploaded-documents";
import { ConfirmUploadRequest } from "@shipwright/shared/schemas";
import { runGeneratingPipeline, runRevisionPipeline } from "../agent/pipelines/generation";
import { Spans } from "@shipwright/observability";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wraps a job handler in a named span and logs any cause (typed error or
 * defect) before re-throwing so the MessageQueue consumer can nack.
 *
 * Using Effect.withSpan means every queue job appears as a root trace in
 * Langfuse with the sessionId attached, making it trivial to correlate a
 * failed job to a session.
 */
function withJobSpan<A, E, R>(
  spanName: string,
  sessionId: AgentSessionId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.tapCause((cause) =>
      Effect.logError(`[${spanName}] job failed`).pipe(
        Effect.annotateLogs({ spanName, sessionId }),
        Effect.andThen(Effect.logError(cause)),
      ),
    ),
    // Propagate session ID to every child span so Langfuse can filter/group
    // all observations within a pipeline run by session.
    Effect.annotateSpans(Spans.session(sessionId)),
    Effect.withSpan(spanName, { attributes: Spans.session(sessionId) }),
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const SessionWorkflowPayload = Schema.Struct({ sessionId: AgentSessionId });
const sessionWorkflowHandler = Effect.fn("sessionWorkflowHandler")(function* (
  delivery: Delivery<unknown>,
) {
  const { sessionId } = yield* Schema.decodeUnknownEffect(SessionWorkflowPayload)(delivery.payload);
  yield* withJobSpan("queue/session.workflow", sessionId, runSessionWorkflow(sessionId));
  yield* delivery.ack;
});

const DocumentsConsumePayload = Schema.Struct({
  sessionId: AgentSessionId,
  uploads: ConfirmUploadRequest.fields.uploads,
});
const documentsConsumeHandler = Effect.fn("documentsConsumeHandler")(function* (
  delivery: Delivery<unknown>,
) {
  const { sessionId, uploads } = yield* Schema.decodeUnknownEffect(DocumentsConsumePayload)(
    delivery.payload,
  );
  yield* withJobSpan(
    "queue/documents.process",
    sessionId,
    processUploadedDocuments({ sessionId, uploads }),
  );
  yield* delivery.ack;
});

const SessionGeneratePayload = Schema.Struct({ sessionId: AgentSessionId });
const sessionGenerateHandler = Effect.fn("sessionGenerateHandler")(function* (
  delivery: Delivery<unknown>,
) {
  const { sessionId } = yield* Schema.decodeUnknownEffect(SessionGeneratePayload)(delivery.payload);
  yield* withJobSpan("queue/session.generate", sessionId, runGeneratingPipeline(sessionId));
  yield* delivery.ack;
});

const SessionRevisePayload = Schema.Struct({ sessionId: AgentSessionId });
const sessionReviseHanlder = Effect.fn("sessionReviseHandler")(function* (
  delivery: Delivery<unknown>,
) {
  const { sessionId } = yield* Schema.decodeUnknownEffect(SessionRevisePayload)(delivery.payload);
  yield* withJobSpan("queue/session.revise", sessionId, runRevisionPipeline(sessionId));
  yield* delivery.ack;
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class JobHandlers extends Context.Service<JobHandlers, void>()(
  "@shipwright/api/queue/job-handlers/JobHandlers",
) {
  static readonly layer = Layer.effect(
    JobHandlers,
    Effect.gen(function* () {
      const mq = yield* MessageQueue;

      yield* mq.consume("documents.process", documentsConsumeHandler);
      yield* mq.consume("session.workflow", sessionWorkflowHandler);
      yield* mq.consume("session.generate", sessionGenerateHandler);
      yield* mq.consume("session.revise", sessionReviseHanlder);
    }),
  );
}
