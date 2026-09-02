import { Schema } from "effect";

export class AgentSessionNotFound extends Schema.TaggedError<
  AgentSessionNotFound,
  { readonly brand: unique symbol }
>()("AgentSessionNotFound", {}, { httpApiStatus: 404 }) {}

export class CreateAgentSessionError extends Schema.TaggedError<
  CreateAgentSessionError,
  { readonly brand: unique symbol }
>()("CreateAgentSessionError", { cause: Schema.optional(Schema.Defect()) }, { httpApiStatus: 500 }) {}

export class MissingUploads extends Schema.TaggedError<
  MissingUploads,
  { readonly brand: unique symbol }
>()("MissingUploads", { missingKeys: Schema.Array(Schema.String) }, { httpApiStatus: 400 }) {}

export class ConfirmUploadError extends Schema.TaggedError<
  ConfirmUploadError,
  { readonly brand: unique symbol }
>()("ConfirmUploadError", {}, { httpApiStatus: 500 }) {}

export class SessionStateError extends Schema.TaggedError<
  SessionStateError,
  { readonly brand: unique symbol }
>()("SessionStateError", { message: Schema.String }, { httpApiStatus: 409 }) {}

export class AnalysisPipelineError extends Schema.TaggedError<
  AnalysisPipelineError,
  { readonly brand: unique symbol }
>()("AnalysisPipelineError", { cause: Schema.optional(Schema.Defect()) }, { httpApiStatus: 500 }) {}

export class ConfirmAnalysisError extends Schema.TaggedError<
  ConfirmAnalysisError,
  { readonly brand: unique symbol }
>()("ConfirmAnalysisError", { cause: Schema.optional(Schema.Defect()) }, { httpApiStatus: 500 }) {}

export class OutputNotFoundError extends Schema.TaggedError<
  OutputNotFoundError,
  { readonly brand: unique symbol }
>()("OutputNotFoundError", {}, { httpApiStatus: 404 }) {}

export class RevisionError extends Schema.TaggedError<
  RevisionError,
  { readonly brand: unique symbol }
>()("RevisionError", {}, { httpApiStatus: 500 }) {}

export class ServiceUnavailableError extends Schema.TaggedError<
  ServiceUnavailableError,
  { readonly brand: unique symbol }
>()("ServiceUnavailableError", { message: Schema.String }, { httpApiStatus: 503 }) {}

export class RetrySessionError extends Schema.TaggedError<
  RetrySessionError,
  { readonly brand: unique symbol }
>()("RetrySessionError", { cause: Schema.optional(Schema.Defect()) }, { httpApiStatus: 500 }) {}

// SHIP-173 — job not found, or found but not owned by this session (never
// distinguished in the response: same as AgentSessionNotFound's rationale,
// a 404 must not leak whether a job exists under a session the caller
// doesn't own).
export class JobNotFoundError extends Schema.TaggedError<
  JobNotFoundError,
  { readonly brand: unique symbol }
>()("JobNotFoundError", {}, { httpApiStatus: 404 }) {}

// SHIP-173 — the job exists (and belongs to this session) but isn't in a
// retryable state (e.g. still active, or already completed).
export class JobNotRetryableError extends Schema.TaggedError<
  JobNotRetryableError,
  { readonly brand: unique symbol }
>()("JobNotRetryableError", { state: Schema.String }, { httpApiStatus: 409 }) {}
