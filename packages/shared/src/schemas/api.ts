import { pipe, Schema } from "effect";
import { AgentSessionId } from "../domain/ids.ts";

export class GetAgentSessionResponse extends Schema.Class<
  GetAgentSessionResponse,
  { readonly brand: unique symbol }
>("GetAgentSessionResponse")({
  id: Schema.String,
  createdAt: Schema.DateFromString,
  status: Schema.String,
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      rationale: Schema.String,
      sourceDocuments: Schema.Array(Schema.String),
      orderIndex: Schema.Int,
    }),
  ),
}) {}

export class GetAgentSessionFinalOutputResponse extends Schema.Class<
  GetAgentSessionFinalOutputResponse,
  { readonly brand: unique symbol }
>("GetAgentSessionFinalOutputResponse")({
  projectBrief: Schema.NullOr(Schema.String),
  implementationPrd: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.Int),
}) {}

export class ConfirmAnalysisResponse extends Schema.Class<
  ConfirmAnalysisResponse,
  { readonly brand: unique symbol }
>("ConfirmAnalysisResponse")({ started: Schema.Boolean }) {}

export class OutputDownloadUrlResponse extends Schema.Class<
  OutputDownloadUrlResponse,
  { readonly brand: unique symbol }
>("OutputDownloadUrlResponse")({ url: Schema.String }) {}

export class ReviseRequest extends Schema.Class<ReviseRequest, { readonly brand: unique symbol }>(
  "ReviseRequest",
)({
  feedback: Schema.String,
}) {}

export class ReviseResponse extends Schema.Class<ReviseResponse, { readonly brand: unique symbol }>(
  "ReviseResponse",
)({
  started: Schema.Boolean,
}) {}

export class GetAgentSessionProgressResponse extends Schema.Class<
  GetAgentSessionProgressResponse,
  { readonly brand: unique symbol }
>("GetAgentSessionProgressResponse")({ started: Schema.Boolean }) {}

export class GetAgentSessionProgressRequest extends Schema.Class<
  GetAgentSessionProgressRequest,
  { readonly brand: unique symbol }
>("GetAgentSessionProgressRequest")({}) {}

export class PostAgentSessionAnswersResponse extends Schema.Class<
  PostAgentSessionAnswersResponse,
  { readonly brand: unique symbol }
>("PostAgentSessionAnswersResponse")({ sufficient: Schema.Boolean, round: Schema.Int }) {}

export class PostAgentSessionAnswersRequest extends Schema.Class<
  PostAgentSessionAnswersRequest,
  { readonly brand: unique symbol }
>("PostAgentSessionAnswersRequest")({
  answers: Schema.Array(Schema.Struct({ questionId: Schema.String, text: Schema.String })),
}) {}

export class CreateAgentSessionRequest extends Schema.Class<
  CreateAgentSessionRequest,
  { readonly brand: unique symbol }
>("CreateAgentSessionRequest")({
  files: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      mimeType: Schema.String,
      sizeBytes: Schema.Int.check(Schema.isLessThanOrEqualTo(100_000_000)),
    }),
  ).check(Schema.isMinLength(1)),
}) {}

export class CreateAgentSessionResponse extends Schema.Class<
  CreateAgentSessionResponse,
  { readonly brand: unique symbol }
>("CreateAgentSessionResponse")({
  sessionId: AgentSessionId,
  uploads: pipe(
    Schema.Array(
      Schema.Struct({
        presignedUrl: Schema.String,
        s3Key: Schema.String,
        documentId: Schema.String,
      }),
    ),
    Schema.mutable,
  ),
}) {}

export class ConfirmUploadRequest extends Schema.Class<
  ConfirmUploadRequest,
  { readonly brand: unique symbol }
>("ConfirmUploadRequest")({
  uploads: Schema.Array(Schema.Struct({ s3Key: Schema.String, documentId: Schema.String })),
}) {}

export class ConfirmUploadResponse extends Schema.Class<
  ConfirmUploadResponse,
  { readonly brand: unique symbol }
>("ConfirmUploadResponse")({ valid: Schema.Boolean }) {}
