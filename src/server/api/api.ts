import { pipe, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, OpenApi, HttpApiSchema, HttpApiGroup } from "effect/unstable/httpapi";
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
} from "../../shared/schemas/api.js";
import {
	CreateAgentSessionError,
	MissingUploads,
	ConfirmUploadError,
	AgentSessionNotFound,
	SessionStateError,
	AnalysisPipelineError,
	ConfirmAnalysisError,
} from "../../shared/domain/errors.js";

class SystemApiGroup extends HttpApiGroup.make("system")
	.add(
		HttpApiEndpoint.get("health", "/health", { success: Schema.String }),
		HttpApiEndpoint.post("sessionUploadUrl", "/sessions/upload-url", {
			payload: CreateAgentSessionRequest,
			success: CreateAgentSessionResponse,
			error: CreateAgentSessionError,
		}),

		HttpApiEndpoint.post("confirmUpload", "/sessions/:sessionId/confirm-upload", {
			params: { sessionId: Schema.String },
			payload: ConfirmUploadRequest,
			success: ConfirmUploadResponse,
			error: [MissingUploads, ConfirmUploadError],
		}),
		HttpApiEndpoint.get("getAgentSessionById", "/sessions/:id", {
			params: { id: Schema.String },
			success: GetAgentSessionResponse,
			error: pipe(AgentSessionNotFound, HttpApiSchema.asNoContent({ decode: () => new AgentSessionNotFound() })),
		}),
		HttpApiEndpoint.post("confirmAnalysis", "/sessions/:id/confirm", {
			params: { id: Schema.String },
			success: ConfirmAnalysisResponse,
			error: ConfirmAnalysisError,
		}),
		HttpApiEndpoint.post("getSessionProgress", "/sessions/:id/stream", {
			params: { id: Schema.String },
			success: GetAgentSessionProgressResponse,
			error: AnalysisPipelineError,
		}),
		HttpApiEndpoint.post("submitSessionAnswers", "/sessions/:id/answers", {
			params: { id: Schema.String },
			payload: PostAgentSessionAnswersRequest,
			success: PostAgentSessionAnswersResponse,
			error: [SessionStateError, AnalysisPipelineError],
		}),
		HttpApiEndpoint.get("getSessionFinalOutput", "/sessions/:id/output", {
			// INFO: This is where you post answers, and get something in return
			params: { id: Schema.String },
			success: GetAgentSessionFinalOutputResponse,
			error: AgentSessionNotFound, // TODO:
		}),
	)
	.prefix("/api") {}

export class Api extends HttpApi.make("api")
	.add(SystemApiGroup)
	.annotateMerge(OpenApi.annotations({ title: "Shiprweck User API" })) {}
