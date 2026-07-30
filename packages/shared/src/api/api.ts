import { pipe, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  OpenApi,
  HttpApiSchema,
  HttpApiGroup,
} from "effect/unstable/httpapi";
import {
  CreateAgentSessionRequest,
  CreateAgentSessionResponse,
  ConfirmUploadRequest,
  ConfirmUploadResponse,
  GetAgentSessionResponse,
  GetAgentSessionProgressResponse,
  PostAgentSessionAnswersRequest,
  PostAgentSessionAnswersResponse,
  GetAgentSessionFinalOutputResponse,
  ConfirmAnalysisResponse,
  OutputDownloadUrlResponse,
  ReviseRequest,
  ReviseResponse,
} from "../schemas/api.js";
import {
  CreateAgentSessionError,
  MissingUploads,
  ConfirmUploadError,
  AgentSessionNotFound,
  SessionStateError,
  AnalysisPipelineError,
  ConfirmAnalysisError,
  OutputNotFoundError,
  RevisionError,
} from "../domain/errors.js";
import { Authorization } from "./middleware.js";
import { AgentSessionId } from "../domain/ids.ts";

export class PublicApiGroup extends HttpApiGroup.make("public").add(
  HttpApiEndpoint.get("health", "/health", {
    success: Schema.Struct({
      status: Schema.Literals(["ok", "error"]),
      version: Schema.String,
    }),
  }),
) {}

export class SessionStorageApi extends HttpApiGroup.make("storage")
  .add(
    HttpApiEndpoint.post("sessionUploadUrl", "/sessions/upload-url", {
      payload: CreateAgentSessionRequest,
      success: CreateAgentSessionResponse,
      error: CreateAgentSessionError,
    }),
    HttpApiEndpoint.post("confirmUpload", "/sessions/:sessionId/confirm-upload", {
      params: { sessionId: AgentSessionId },
      payload: ConfirmUploadRequest,
      success: ConfirmUploadResponse,
      error: [MissingUploads, ConfirmUploadError],
    }),

    HttpApiEndpoint.get("getOutputDownloadUrl", "/sessions/:sessionId/output/:type/download-url", {
      params: { sessionId: AgentSessionId, type: Schema.String },
      success: OutputDownloadUrlResponse,
      error: OutputNotFoundError,
    }),
  )
  .middleware(Authorization) {}

export class SessionComputationApi extends HttpApiGroup.make("compute")
  .add(
    HttpApiEndpoint.get("getAgentSessionById", "/sessions/:id", {
      params: { sessionId: AgentSessionId },
      success: GetAgentSessionResponse,
      error: pipe(
        AgentSessionNotFound,
        HttpApiSchema.asNoContent({ decode: () => new AgentSessionNotFound() }),
      ),
    }),
    HttpApiEndpoint.post("confirmAnalysis", "/sessions/:sessionId/confirm", {
      params: { sessionId: AgentSessionId },
      success: ConfirmAnalysisResponse,
      error: ConfirmAnalysisError,
    }),
    HttpApiEndpoint.post("getSessionProgress", "/sessions/:sessionId/stream", {
      params: { sessionId: AgentSessionId },
      success: GetAgentSessionProgressResponse,
      error: AnalysisPipelineError,
    }),
  )

  .middleware(Authorization) {}

export class SessionResultsApi extends HttpApiGroup.make("results")
  .add(
    HttpApiEndpoint.post("submitSessionAnswers", "/sessions/:sessionId/answers", {
      params: { sessionId: AgentSessionId },
      payload: PostAgentSessionAnswersRequest,
      success: PostAgentSessionAnswersResponse,
      error: [SessionStateError, AnalysisPipelineError],
    }),
    HttpApiEndpoint.get("getSessionFinalOutput", "/sessions/:sessionId/output", {
      params: { sessionId: AgentSessionId },
      success: GetAgentSessionFinalOutputResponse,
      error: AgentSessionNotFound,
    }),
    HttpApiEndpoint.post("reviseOutput", "/sessions/:id/revise", {
      params: { sessionId: AgentSessionId },
      payload: ReviseRequest,
      success: ReviseResponse,
      error: [SessionStateError, RevisionError],
    }),
  )
  .middleware(Authorization) {}

export class Api extends HttpApi.make("api")
  .add(PublicApiGroup)
  .add(SessionStorageApi)
  .add(SessionComputationApi)
  .add(SessionResultsApi)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "Shipwright API" })) {}
