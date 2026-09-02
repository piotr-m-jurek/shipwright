import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, OpenApi, HttpApiGroup } from "effect/unstable/httpapi";
import {
  CreateAgentSessionRequest,
  CreateAgentSessionResponse,
  ConfirmUploadRequest,
  ConfirmUploadResponse,
  GetAgentSessionResponse,
  GetSessionDocumentsResponse,
  PostAgentSessionAnswersRequest,
  PostAgentSessionAnswersResponse,
  GetAgentSessionFinalOutputResponse,
  ConfirmAnalysisResponse,
  OutputDownloadUrlResponse,
  ReviseRequest,
  ReviseResponse,
  GetHealthResponse,
  RetrySessionResponse,
  GetSessionDebugResponse,
  RetryJobResponse,
  McpTokenGenerateResponse,
  McpTokenStatusResponse,
  McpTokenRevokeResponse,
} from "../schemas/api";
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
  ServiceUnavailableError,
  RetrySessionError,
  JobNotFoundError,
  JobNotRetryableError,
} from "../domain/errors";
import { Authorization } from "./middleware";
import { AgentSessionId } from "../domain/ids";

export class PublicApiGroup extends HttpApiGroup.make("public").add(
  HttpApiEndpoint.get("health", "/health", {
    success: GetHealthResponse,
    error: ServiceUnavailableError,
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
      error: [OutputNotFoundError, ServiceUnavailableError],
    }),
    HttpApiEndpoint.post("retrySession", "/sessions/:sessionId/retry", {
      params: { sessionId: AgentSessionId },
      success: RetrySessionResponse,
      error: [AgentSessionNotFound, RetrySessionError],
    }),
  )
  .middleware(Authorization) {}

export class SessionComputationApi extends HttpApiGroup.make("compute")
  .add(
    HttpApiEndpoint.get("getAgentSessionById", "/sessions/:sessionId", {
      params: { sessionId: AgentSessionId },
      success: GetAgentSessionResponse,
      error: [AgentSessionNotFound, ServiceUnavailableError],
    }),
    HttpApiEndpoint.get("getSessionDocuments", "/sessions/:sessionId/documents", {
      params: { sessionId: AgentSessionId },
      success: GetSessionDocumentsResponse,
      error: [AgentSessionNotFound, ServiceUnavailableError],
    }),
    HttpApiEndpoint.post("confirmAnalysis", "/sessions/:sessionId/confirm", {
      params: { sessionId: AgentSessionId },
      success: ConfirmAnalysisResponse,
      error: [ConfirmAnalysisError, AgentSessionNotFound, ServiceUnavailableError],
    }),
    HttpApiEndpoint.get("getSessionDebug", "/sessions/:sessionId/debug", {
      params: { sessionId: AgentSessionId },
      success: GetSessionDebugResponse,
      error: [AgentSessionNotFound, ServiceUnavailableError],
    }),
    // SHIP-173 — retry a dead-lettered/failed job belonging to this session.
    // jobId is effect-mq's own JobId (opaque string, not one of this app's
    // branded domain ids).
    HttpApiEndpoint.post("retryJob", "/sessions/:sessionId/debug/jobs/:jobId/retry", {
      params: { sessionId: AgentSessionId, jobId: Schema.String },
      success: RetryJobResponse,
      error: [AgentSessionNotFound, JobNotFoundError, JobNotRetryableError, ServiceUnavailableError],
    }),
  )

  .middleware(Authorization) {}

export class SessionResultsApi extends HttpApiGroup.make("results")
  .add(
    HttpApiEndpoint.post("submitSessionAnswers", "/sessions/:sessionId/answers", {
      params: { sessionId: AgentSessionId },
      payload: PostAgentSessionAnswersRequest,
      success: PostAgentSessionAnswersResponse,
      error: [SessionStateError, AnalysisPipelineError, AgentSessionNotFound, ServiceUnavailableError],
    }),
    HttpApiEndpoint.get("getSessionFinalOutput", "/sessions/:sessionId/output", {
      params: { sessionId: AgentSessionId },
      success: GetAgentSessionFinalOutputResponse,
      error: [AgentSessionNotFound, ServiceUnavailableError],
    }),
    HttpApiEndpoint.post("reviseOutput", "/sessions/:id/revise", {
      params: { sessionId: AgentSessionId },
      payload: ReviseRequest,
      success: ReviseResponse,
      error: [SessionStateError, RevisionError, AgentSessionNotFound, ServiceUnavailableError],
    }),
  )
  .middleware(Authorization) {}

export class McpTokenApi extends HttpApiGroup.make("mcp-token")
  .add(
    HttpApiEndpoint.post("generateMcpToken", "/mcp-token", {
      success: McpTokenGenerateResponse,
      error: ServiceUnavailableError,
    }),
    HttpApiEndpoint.get("getMcpTokenStatus", "/mcp-token", {
      success: McpTokenStatusResponse,
      error: ServiceUnavailableError,
    }),
    HttpApiEndpoint.delete("revokeMcpToken", "/mcp-token", {
      success: McpTokenRevokeResponse,
      error: ServiceUnavailableError,
    }),
  )
  .middleware(Authorization) {}

export class Api extends HttpApi.make("api")
  .add(PublicApiGroup)
  .add(SessionStorageApi)
  .add(SessionComputationApi)
  .add(SessionResultsApi)
  .add(McpTokenApi)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "Shipwright API" })) {}
