import { Effect, pipe } from "effect";
import { StorageAdapter } from "../../storage/index.js";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AgentSessionNotFound,
  ConfirmUploadError,
  CreateAgentSessionError,
  MissingUploads,
  AnalysisPipelineError,
  ConfirmAnalysisError,
  OutputNotFoundError,
  RevisionError,
  SessionStateError,
} from "@shipwright/shared/domain/errors.js";
import { processUploadedDocuments } from "../../agent/pipelines/process-uploaded-documents.js";
import { getOrRestoreActor } from "../../agent/session-actor.js";
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
} from "@shipwright/shared/schemas/api.js";
import { Api } from "@shipwright/shared/api.js";
import { DatabaseService } from "../../db/queries.js";
import { CurrentUser } from "@shipwright/shared/middleware.js";
import { createUploadSession } from "../../agent/pipelines/create-upload-session.js";
import { confirmUploadResults } from "../../agent/pipelines/confirm-upload-results.js";
import { runSessionWorkflow } from "../../agent/pipelines/run-session-workflow.js";
import { submitAnswers } from "../../agent/pipelines/submit-answers.js";
import { startRevision } from "../../agent/pipelines/generation.js";
import { SessionStateError as ActorSessionStateError } from "../../agent/errors.js";

export const PublicApiHandlers = HttpApiBuilder.group(Api, "public", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok", version: "0.0.0" })),
);

export const SessionStorageHandlers = HttpApiBuilder.group(Api, "storage", (handlers) =>
  handlers
    .handle(
      "sessionUploadUrl",
      Effect.fnUntraced(function* (p) {
        const user = yield* CurrentUser;

        const { uploads, sessionId } = yield* pipe(
          createUploadSession({ files: p.payload.files, userId: user.id }),
          Effect.mapError(() => new CreateAgentSessionError()),
        );
        return CreateAgentSessionResponse.make({ uploads, sessionId });
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

        // TODO: messageQueue
        yield* pipe(
          processUploadedDocuments({ sessionId, uploads }),
          Effect.mapError((cause) => Effect.logError("processUploadedDocuments failed", cause)),
          Effect.forkDetach,
        );

        return ConfirmUploadResponse.make({ valid: true });
      }),
    )
    .handle("getOutputDownloadUrl", ({ params: { sessionId, type } }) =>
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        const user = yield* CurrentUser;

        yield* pipe(
          db.getAgentSesionByIdForUser({ sessionId, userId: user.id }),
          Effect.fromNullishOr,
          Effect.mapError(() => new OutputNotFoundError()),
        );

        // Validate type param
        if (type !== "project_brief" && type !== "implementation_prd") {
          return yield* new OutputNotFoundError();
        }

        const output = yield* db
          .getLatestOutputByType({ sessionId, type })
          .pipe(Effect.mapError(() => new OutputNotFoundError()));

        if (!output?.s3Key) {
          return yield* new OutputNotFoundError();
        }

        const storage = yield* StorageAdapter;
        // Generate presigned GET URL with 15-minute TTL (not a PUT URL)
        const url = yield* storage
          .generatePresignedGetUrl(output.s3Key, 15)
          .pipe(Effect.mapError(() => new OutputNotFoundError()));

        return OutputDownloadUrlResponse.make({ url });
      }),
    ),
);

export const SessionComputationHandlers = HttpApiBuilder.group(Api, "compute", (handlers) =>
  handlers
    .handle("getAgentSessionById", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        const user = yield* CurrentUser;

        const session = yield* db.getAgentSesionByIdForUser({ sessionId, userId: user.id }).pipe(
          Effect.mapError(() => new AgentSessionNotFound()),
          Effect.flatMap((s) =>
            s === undefined ? Effect.fail(new AgentSessionNotFound()) : Effect.succeed(s),
          ),
        );

        // Include current questions when session is awaiting answers
        const questions =
          session.status === "awaiting_answers"
            ? yield* db
                .getQuestionsBySessionId(sessionId)
                .pipe(Effect.mapError(() => new AgentSessionNotFound()))
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
    .handle("confirmAnalysis", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const actor = yield* pipe(
          getOrRestoreActor(sessionId),
          Effect.mapError(() => new ConfirmAnalysisError()),
        );

        const state = actor.getSnapshot();

        if (state.value === "idle") {
          actor.send({ type: "UPLOAD_COMPLETE" });
          actor.send({ type: "USER_CONFIRM" }); // uploading → summarizing
          yield* pipe(
            runSessionWorkflow(sessionId),
            Effect.tapError((e) =>
              Effect.sync(() =>
                console.error(
                  "[confirmAnalysis] workflow error:",
                  JSON.stringify(e, null, 2),
                  (e as any)?.cause,
                ),
              ),
            ),
            Effect.mapError(() => new ConfirmAnalysisError()),
            Effect.forkDetach,
          );
        }

        return ConfirmAnalysisResponse.make({ started: true });
      }),
    )
    .handle("getSessionProgress", ({ params: { sessionId: _sessionId } }) =>
      // Legacy endpoint — use POST /sessions/:id/confirm instead.
      // Returns current session status for polling.
      // TODO: Remove at some point
      Effect.sync(() => GetAgentSessionProgressResponse.make({ started: true })),
    ),
);

export const SessionResultsHandlers = HttpApiBuilder.group(Api, "results", (handlers) =>
  handlers
    .handle("submitSessionAnswers", ({ payload: { answers }, params: { sessionId } }) =>
      Effect.gen(function* () {
        const result = yield* pipe(
          submitAnswers(sessionId, answers as { questionId: string; text: string }[]),
          Effect.mapError(() => new AnalysisPipelineError()),
        );
        return PostAgentSessionAnswersResponse.make({
          sufficient: result.sufficient,
          round: result.round,
        });
      }),
    )
    .handle("getSessionFinalOutput", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        const user = yield* CurrentUser;

        const session = yield* db
          .getAgentSesionByIdForUser({ sessionId, userId: user.id })
          .pipe(Effect.mapError(() => new AgentSessionNotFound()));
        if (!session) return yield* new AgentSessionNotFound();

        const allOutputs = yield* db
          .getOutputsBySessionId(sessionId)
          .pipe(Effect.mapError(() => new AgentSessionNotFound()));

        const brief = allOutputs.find((o) => o.type === "project_brief");
        const prd = allOutputs.find((o) => o.type === "implementation_prd");

        return GetAgentSessionFinalOutputResponse.make({
          projectBrief: brief?.content ?? null,
          implementationPrd: prd?.content ?? null,
          version: brief?.version ?? null,
        });
      }),
    )
    .handle("reviseOutput", ({ payload: { feedback }, params: { sessionId } }) =>
      Effect.gen(function* () {
        const result = yield* pipe(
          startRevision(sessionId, feedback),
          Effect.mapError((e) => {
            if (e instanceof ActorSessionStateError) {
              return new SessionStateError({ message: e.message });
            }
            return new RevisionError();
          }),
        );
        return ReviseResponse.make({ started: result.started });
      }),
    ),
);
