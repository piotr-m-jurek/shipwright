import { Effect, pipe } from "effect";
import { StorageAdapter } from "../storage/index.js";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AgentSessionNotFound,
  ConfirmUploadError,
  CreateAgentSessionError,
  MissingUploads,
  SessionStateError,
  AnalysisPipelineError,
  ConfirmAnalysisError,
  OutputNotFoundError,
  RevisionError,
} from "../shared/domain/errors.js";
import { getAgentSesionById, getQuestionsBySessionId } from "../db/queries.js";
import { confirmUploadResults } from "../agent/confirm-upload-results.js";
import { processUploadedDocuments } from "../agent/process-uploaded-documents.js";
import { createUploadSession } from "../agent/create-upload-session.js";
import { runAnalysisPipeline, submitAnswers, getOrRestoreActor, runGeneratingPipeline, startRevision } from "../agent/session-actor.js";
import { getOutputsBySessionId, getLatestOutputByType } from "../db/queries.js";
import {
  CreateAgentSessionResponse,
  GetAgentSessionResponse,
  ConfirmUploadResponse,
  GetAgentSessionProgressResponse,
  PostAgentSessionAnswersResponse,
  ConfirmAnalysisResponse,
  GetAgentSessionFinalOutputResponse,
  OutputDownloadUrlResponse,
  ReviseResponse,
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
      // Legacy endpoint — use POST /sessions/:id/confirm instead.
      // Returns current session status for polling.
      Effect.gen(function* () {
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
    .handle("getSessionFinalOutput", ({ params: { id } }) =>
      Effect.gen(function* () {
        // Verify session exists first
        const session = yield* Effect.tryPromise({
          try: () => getAgentSesionById(id),
          catch: () => new AgentSessionNotFound(),
        });
        if (!session) return yield* new AgentSessionNotFound();

        const allOutputs = yield* Effect.tryPromise({
          try: () => getOutputsBySessionId(id),
          catch: () => new AgentSessionNotFound(),
        });

        const brief = allOutputs.find((o) => o.type === "project_brief");
        const prd = allOutputs.find((o) => o.type === "implementation_prd");

        return GetAgentSessionFinalOutputResponse.make({
          projectBrief: brief?.content ?? null,
          implementationPrd: prd?.content ?? null,
          version: brief?.version ?? null,
        });
      }),
    )
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
    .handle("getOutputDownloadUrl", ({ params: { id, type } }) =>
      Effect.gen(function* () {
        // Validate type param
        if (type !== "project_brief" && type !== "implementation_prd") {
          return yield* new OutputNotFoundError();
        }

        const output = yield* Effect.tryPromise({
          try: () => getLatestOutputByType(id, type as "project_brief" | "implementation_prd"),
          catch: () => new OutputNotFoundError(),
        });

        if (!output?.s3Key) {
          return yield* new OutputNotFoundError();
        }

        const storage = yield* StorageAdapter;
        // Generate presigned GET URL with 15-minute TTL (not a PUT URL)
        const url = yield* storage.generatePresignedGetUrl(output.s3Key, 15).pipe(
          Effect.mapError(() => new OutputNotFoundError()),
        );

        return OutputDownloadUrlResponse.make({ url });
      }),
    )
    .handle("reviseOutput", ({ payload: { feedback }, params: { id } }) =>
      Effect.gen(function* () {
        const result = yield* pipe(
          startRevision(id, feedback),
          Effect.mapError((e) => {
            if (e._tag === "shipwright/agent/SessionStateError") {
              return new SessionStateError({ message: (e as any).message });
            }
            return new RevisionError();
          }),
        );
        return ReviseResponse.make({ started: result.started });
      }),
    )
    .handle("health", () => Effect.succeed("Healthy")),
);
