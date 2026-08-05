import { Schema } from "effect";

export class AgentSessionNotFound extends Schema.TaggedErrorClass<
  AgentSessionNotFound,
  { readonly brand: unique symbol }
>()("AgentSessionNotFound", {}, { httpApiStatus: 404 }) {}

export class CreateAgentSessionError extends Schema.TaggedErrorClass<
  CreateAgentSessionError,
  { readonly brand: unique symbol }
>()("CreateAgentSessionError", { cause: Schema.optional(Schema.Defect()) }, { httpApiStatus: 500 }) {}

export class MissingUploads extends Schema.TaggedErrorClass<
  MissingUploads,
  { readonly brand: unique symbol }
>()("MissingUploads", { missingKeys: Schema.Array(Schema.String) }, { httpApiStatus: 400 }) {}

export class ConfirmUploadError extends Schema.TaggedErrorClass<
  ConfirmUploadError,
  { readonly brand: unique symbol }
>()("ConfirmUploadError", {}, { httpApiStatus: 500 }) {}

export class SessionStateError extends Schema.TaggedErrorClass<
  SessionStateError,
  { readonly brand: unique symbol }
>()("SessionStateError", { message: Schema.String }, { httpApiStatus: 409 }) {}

export class AnalysisPipelineError extends Schema.TaggedErrorClass<
  AnalysisPipelineError,
  { readonly brand: unique symbol }
>()("AnalysisPipelineError", { cause: Schema.optional(Schema.Defect()) }, { httpApiStatus: 500 }) {}

export class ConfirmAnalysisError extends Schema.TaggedErrorClass<
  ConfirmAnalysisError,
  { readonly brand: unique symbol }
>()("ConfirmAnalysisError", { cause: Schema.optional(Schema.Defect()) }, { httpApiStatus: 500 }) {}

export class OutputNotFoundError extends Schema.TaggedErrorClass<
  OutputNotFoundError,
  { readonly brand: unique symbol }
>()("OutputNotFoundError", {}, { httpApiStatus: 404 }) {}

export class RevisionError extends Schema.TaggedErrorClass<
  RevisionError,
  { readonly brand: unique symbol }
>()("RevisionError", {}, { httpApiStatus: 500 }) {}

export class ServiceUnavailableError extends Schema.TaggedErrorClass<
  ServiceUnavailableError,
  { readonly brand: unique symbol }
>()("ServiceUnavailableError", { message: Schema.String }, { httpApiStatus: 503 }) {}

export class RetrySessionError extends Schema.TaggedErrorClass<
  RetrySessionError,
  { readonly brand: unique symbol }
>()("RetrySessionError", { cause: Schema.optional(Schema.Defect()) }, { httpApiStatus: 500 }) {}
