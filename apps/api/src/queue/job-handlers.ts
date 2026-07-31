import { Context, Effect, Layer, Schema } from "effect";
import { Delivery, MessageQueue } from "./MessageQueue.ts";
import { AgentSessionId } from "@shipwright/shared/domain/ids";
import { runSessionWorkflow } from "../agent/pipelines/run-session-workflow.ts";
import { processUploadedDocuments } from "../agent/pipelines/process-uploaded-documents.ts";
import { ConfirmUploadRequest } from "@shipwright/shared/schemas";
import { runGeneratingPipeline, runRevisionPipeline } from "../agent/pipelines/generation.ts";

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

const SessionWorkflowPayload = Schema.Struct({ sessionId: AgentSessionId });
const sessionWorkflowHandler = Effect.fn("sessionWorkflowhandler")(function* (
  delivery: Delivery<unknown>,
) {
  const { sessionId } = yield* Schema.decodeUnknownEffect(SessionWorkflowPayload)(delivery.payload);

  yield* runSessionWorkflow(sessionId);
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
  yield* processUploadedDocuments({ sessionId, uploads });
  yield* delivery.ack;
});

const SessionGeneratePayload = Schema.Struct({ sessionId: AgentSessionId });
const sessionGenerateHandler = Effect.fn("sessionGenerateHandler")(function* (
  delivery: Delivery<unknown>,
) {
  const { sessionId } = yield* Schema.decodeUnknownEffect(SessionGeneratePayload)(delivery.payload);
  yield* runGeneratingPipeline(sessionId);
  yield* delivery.ack;
});

const SessionRevisePayload = Schema.Struct({ sessionId: AgentSessionId });
const sessionReviseHanlder = Effect.fn("sessionReviseHandler")(function* (
  delivery: Delivery<unknown>,
) {
  const { sessionId } = yield* Schema.decodeUnknownEffect(SessionRevisePayload)(delivery.payload);
  yield* runRevisionPipeline(sessionId);
  yield* delivery.ack;
});
