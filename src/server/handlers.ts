import { Effect, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AgentSessionNotFound,
  ConfirmUploadError,
  CreateAgentSessionError,
  MissingUploads,
  SessionStateError,
  AnalysisPipelineError,
  ConfirmAnalysisError,
} from "../shared/domain/errors.js";
import { getAgentSesionById, getQuestionsBySessionId } from "../db/queries.js";
import { confirmUploadResults } from "../agent/confirm-upload-results.js";
import { processUploadedDocuments } from "../agent/process-uploaded-documents.js";
import { createUploadSession } from "../agent/create-upload-session.js";
import { runAnalysisPipeline, submitAnswers, getOrRestoreActor } from "../agent/session-actor.js";
import {
  CreateAgentSessionResponse,
  GetAgentSessionResponse,
  ConfirmUploadResponse,
  GetAgentSessionProgressResponse,
  PostAgentSessionAnswersResponse,
  ConfirmAnalysisResponse,
} from "../shared/schemas/api.js";
import { Api } from "./api/api.js";

export const SystemApiHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers
    .handle(
      "sessionUploadUrl",
      Effect.fnUntraced(function* ({ payload: { files } }) {
        const result = yield* pipe(
          createUploadSession(files),
          Effect.mapError(() => new CreateAgentSessionError()),
        );
        return CreateAgentSessionResponse.make({
          uploads: result.uploads,
          sessionId: result.sessionId,
        });
      }),
    )
    .handle(
      "confirmUpload",
      Effect.fnUntraced(function* ({ payload: { uploads }, params: { sessionId } }) {
        const results = yield* pipe(
          confirmUploadResults(uploads),
          Effect.mapError(() => new ConfirmUploadError()),
        );

        const missingKeys = results.filter((r) => !r.exists).map((r) => r.s3Key);
        if (missingKeys.length > 0) {
          return yield* new MissingUploads({ missingKeys });
        }

        yield* pipe(
          processUploadedDocuments({ sessionId, uploads }),
          Effect.mapError((cause) => Effect.logError("processUploadedDocuments failed", cause)),
          Effect.forkDetach,
        );

        return ConfirmUploadResponse.make({ valid: true });
      }),
    )
    .handle("confirmAnalysis", ({ params: { id } }) =>
      Effect.gen(function* () {
        // Get or create the actor for this session
        const actor = yield* pipe(
          getOrRestoreActor(id),
          Effect.mapError(() => new ConfirmAnalysisError()),
        );

        // Advance the machine: idle → uploading → processing → analyzing
        // (V1 deviation: summarization runs inside the pipeline, not in a separate
        // summarizing state, so documentSummaries[] is empty when the guard fires
        // and always defaults to context mode — acceptable for V1 corpus sizes)
        actor.send({ type: "UPLOAD_COMPLETE" });
        actor.send({ type: "USER_CONFIRM" }); // uploading → processing
        actor.send({ type: "USER_CONFIRM" }); // processing → analyzing

        // Fork the analysis pipeline — fire and forget
        // Client polls GET /sessions/:id for status + questions
        yield* pipe(
          runAnalysisPipeline(id),
          Effect.tapError((e) =>
            Effect.sync(() =>
              console.error(
                "[confirmAnalysis] pipeline error:",
                JSON.stringify(e, null, 2),
                (e as any)?.cause,
              ),
            ),
          ),
          Effect.mapError(() => new ConfirmAnalysisError()),
          Effect.forkDetach,
        );

        return ConfirmAnalysisResponse.make({ started: true });
      }),
    )
    .handle("getSessionProgress", ({ params: { id } }) =>
      // Trigger the analysis pipeline async (forkDetach) — returns 202-style immediately.
      // The actor advances through states as each pass completes.
      // The client polls GET /sessions/:id for status + questions.
      Effect.gen(function* () {
        yield* pipe(
          runAnalysisPipeline(id),
          Effect.mapError(() => new AnalysisPipelineError({ cause: new Error("pipeline failed") })),
          Effect.forkDetach,
        );
        return GetAgentSessionProgressResponse.make({ started: true });
      }),
    )
    .handle("submitSessionAnswers", ({ payload: { answers }, params: { id } }) =>
      Effect.gen(function* () {
        const result = yield* pipe(
          submitAnswers(id, answers as { questionId: string; text: string }[]),
          Effect.mapError((e) => {
            if (e._tag === "shipwright/agent/SessionStateError") {
              return new SessionStateError({ message: e.message });
            }
            return new AnalysisPipelineError({ cause: e });
          }),
        );
        return PostAgentSessionAnswersResponse.make({
          sufficient: result.sufficient,
          round: result.round,
        });
      }),
    )
    .handle("getSessionFinalOutput", () => Effect.die("NotImplemented"))
    .handle("getAgentSessionById", ({ params }) =>
      Effect.gen(function* () {
        const session = yield* pipe(
          Effect.tryPromise({
            try: () => getAgentSesionById(params.id),
            catch: () => new AgentSessionNotFound(),
          }),
          Effect.flatMap((s) =>
            s === undefined ? Effect.fail(new AgentSessionNotFound()) : Effect.succeed(s),
          ),
        );

        // Include current questions when session is awaiting answers
        const questions =
          session.status === "awaiting_answers"
            ? yield* Effect.tryPromise({
                try: () => getQuestionsBySessionId(params.id),
                catch: () => new AgentSessionNotFound(),
              })
            : [];

        return GetAgentSessionResponse.make({
          id: session.id,
          createdAt: session.createdAt,
          status: session.status,
          questions: questions.map((q) => ({
            id: q.id,
            text: q.text,
            rationale: q.rationale,
            sourceDocuments: q.sourceDocuments,
            orderIndex: q.orderIndex,
          })),
        });
      }),
    )
    .handle("health", () => Effect.succeed("Healthy")),
);
