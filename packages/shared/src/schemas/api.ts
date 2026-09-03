import { pipe, Schema } from "effect";
import { AgentSessionId, DocumentId, QuestionId } from "../domain/ids";

// SHIP-182 plannotator follow-up — from/to arrive as string path segments;
// decoding straight into the branded OutputVersion at the schema level
// (instead of Number.parseInt + a manual Number.isInteger check in the
// handler) means a malformed version rejects before the handler ever runs.
export const OutputVersionParam = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("OutputVersion"));

export class GetHealthResponse extends Schema.Class<
  GetHealthResponse,
  { readonly brand: unique symbol }
>("GetHealthResponse")({
  status: Schema.Literals(["ok", "error"]),
  version: Schema.String,
}) {}

export class GetAgentSessionResponse extends Schema.Class<
  GetAgentSessionResponse,
  { readonly brand: unique symbol }
>("GetAgentSessionResponse")({
  id: AgentSessionId,
  createdAt: Schema.DateFromString,
  status: Schema.String,
  inputMode: Schema.Literals(["context", "retrieval"]),
  errorReason: Schema.NullOr(Schema.String),
  questions: Schema.Array(
    Schema.Struct({
      id: QuestionId,
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

// SHIP-115 Step 6 — MCP token (separate from the better-auth session_token,
// see packages/auth/src/mcp-token.ts for why).
export class McpTokenGenerateResponse extends Schema.Class<
  McpTokenGenerateResponse,
  { readonly brand: unique symbol }
>("McpTokenGenerateResponse")({
  // The raw token, returned exactly once. Never retrievable again after this
  // response — only its hash is persisted.
  token: Schema.String,
}) {}

export class McpTokenStatusResponse extends Schema.Class<
  McpTokenStatusResponse,
  { readonly brand: unique symbol }
>("McpTokenStatusResponse")({ hasActiveToken: Schema.Boolean }) {}

export class McpTokenRevokeResponse extends Schema.Class<
  McpTokenRevokeResponse,
  { readonly brand: unique symbol }
>("McpTokenRevokeResponse")({ revoked: Schema.Boolean }) {}

export class ReviseRequest extends Schema.Class<ReviseRequest, { readonly brand: unique symbol }>(
  "ReviseRequest",
)({ feedback: Schema.String }) {}

export class ReviseResponse extends Schema.Class<ReviseResponse, { readonly brand: unique symbol }>(
  "ReviseResponse",
)({ started: Schema.Boolean }) {}

export class PostAgentSessionAnswersResponse extends Schema.Class<
  PostAgentSessionAnswersResponse,
  { readonly brand: unique symbol }
>("PostAgentSessionAnswersResponse")({ sufficient: Schema.Boolean, round: Schema.Int }) {}

export class PostAgentSessionAnswersRequest extends Schema.Class<
  PostAgentSessionAnswersRequest,
  { readonly brand: unique symbol }
>("PostAgentSessionAnswersRequest")({
  answers: Schema.Array(Schema.Struct({ questionId: QuestionId, text: Schema.String })),
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
        documentId: DocumentId,
      }),
    ),
    Schema.mutable,
  ),
}) {}

export class ConfirmUploadRequest extends Schema.Class<
  ConfirmUploadRequest,
  { readonly brand: unique symbol }
>("ConfirmUploadRequest")({
  uploads: Schema.Array(Schema.Struct({ s3Key: Schema.String, documentId: DocumentId })),
}) {}

export class ConfirmUploadResponse extends Schema.Class<
  ConfirmUploadResponse,
  { readonly brand: unique symbol }
>("ConfirmUploadResponse")({ valid: Schema.Boolean }) {}

// SHIP-182 — deterministic section-level diff between two output versions.
// No LLM: sections are matched by markdown heading text, "modified" carries
// both bodies in full (line-level highlighting is a frontend concern).
export class OutputDiffResponse extends Schema.Class<
  OutputDiffResponse,
  { readonly brand: unique symbol }
>("OutputDiffResponse")({
  sections: Schema.Array(
    Schema.Struct({
      heading: Schema.String,
      changeType: Schema.Literals(["added", "removed", "modified", "unchanged"]),
      oldContent: Schema.NullOr(Schema.String),
      newContent: Schema.NullOr(Schema.String),
    }),
  ),
}) {}

export class RetrySessionResponse extends Schema.Class<
  RetrySessionResponse,
  { readonly brand: unique symbol }
>("RetrySessionResponse")({ queued: Schema.Boolean }) {}

export class RetryJobResponse extends Schema.Class<
  RetryJobResponse,
  { readonly brand: unique symbol }
>("RetryJobResponse")({ retried: Schema.Boolean }) {}

export class GetSessionDocumentsResponse extends Schema.Class<
  GetSessionDocumentsResponse,
  { readonly brand: unique symbol }
>("GetSessionDocumentsResponse")({
  documents: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      filename: Schema.String,
      mimeType: Schema.String,
      sizeBytes: Schema.Int,
      status: Schema.String,
    }),
  ),
}) {}

export class GetSessionDebugResponse extends Schema.Class<
  GetSessionDebugResponse,
  { readonly brand: unique symbol }
>("GetSessionDebugResponse")({
  session: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    createdAt: Schema.DateFromString,
    updatedAt: Schema.DateFromString,
  }),
  xstate: Schema.NullOr(
    Schema.Struct({
      value: Schema.String,
      round: Schema.Int,
      inputMode: Schema.Literals(["context", "retrieval"]),
      outputVersion: Schema.Int,
      documentSummaryCount: Schema.Int,
      questionCount: Schema.Int,
      answerCount: Schema.Int,
      revisionFeedback: Schema.NullOr(Schema.String),
      raw: Schema.Unknown,
    }),
  ),
  queue: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      queue: Schema.String,
      status: Schema.String,
      attempts: Schema.Int,
      maxAttempts: Schema.Int,
      createdAt: Schema.DateFromString,
    }),
  ),
  documents: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      filename: Schema.String,
      status: Schema.String,
      mimeType: Schema.String,
      sizeBytes: Schema.Int,
      tokenCount: Schema.NullOr(Schema.Int),
    }),
  ),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      orderIndex: Schema.Int,
    }),
  ),
  answers: Schema.Array(
    Schema.Struct({
      questionId: Schema.String,
      text: Schema.String,
      round: Schema.Int,
    }),
  ),
  outputs: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      version: Schema.NullOr(Schema.Int),
      createdAt: Schema.DateFromString,
      contentLength: Schema.Int,
    }),
  ),
}) {}
