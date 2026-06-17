import { pipe, Schema } from "effect";

export class GetAgentSessionResponse extends Schema.Class<GetAgentSessionResponse>(
  "GetAgentSessionResponse",
)({ id: Schema.String, createdAt: Schema.DateFromString, status: Schema.String }) {}

export class GetAgentSessionFinalOutputResponse extends Schema.Class<GetAgentSessionFinalOutputResponse>(
  "GetAgentSessionFinalOutputResponse",
)({}) {}

export class GetAgentSessionProgressResponse extends Schema.Class<GetAgentSessionProgressResponse>(
  "GetAgentSessionProgressResponse",
)({}) {}

export class GetAgentSessionProgressRequest extends Schema.Class<GetAgentSessionProgressRequest>(
  "GetAgentSessionProgressRequest",
)({}) {}

export class PostAgentSessionAnswersResponse extends Schema.Class<PostAgentSessionAnswersResponse>(
  "PostAgentSessionAnswersResponse",
)({}) {}

export class PostAgentSessionAnswersRequest extends Schema.Class<PostAgentSessionAnswersRequest>(
  "PostAgentSessionAnswersRequest",
)({
  answers: Schema.Array(Schema.Struct({ questionId: Schema.String, text: Schema.String })),
}) {}

export class CreateAgentSessionRequest extends Schema.Class<CreateAgentSessionRequest>(
  "CreateAgentSessionRequest",
)({ files: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      documentType: Schema.Literals(["transcript", "prd_draft", "rfp", "notes"]), // INFO: DocumentTypeEnum from db/schema
      mimeType: Schema.String,
      sizeBytes: Schema.Int.check(Schema.isLessThanOrEqualTo(100_000_000)),
    }),
  ).check(Schema.isMinLength(1)),
}) {}

export class CreateAgentSessionResponse extends Schema.Class<CreateAgentSessionResponse>(
  "CreateAgentSessionResponse",
)({
  sessionId: Schema.String, // TODO: Make it SessionId branded type
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

export class ConfirmUploadRequest extends Schema.Class<ConfirmUploadRequest>(
  "ConfirmUploadRequest",
)({
  uploads: Schema.Array(Schema.Struct({ s3Key: Schema.String, documentId: Schema.String })),
}) {}

export class ConfirmUploadResponse extends Schema.Class<ConfirmUploadResponse>(
  "ConfirmUploadResponse",
)({ valid: Schema.Boolean }) {}
