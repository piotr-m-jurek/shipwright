import { Schema } from "effect";

export class AgentSessionNotFound extends Schema.TaggedErrorClass<AgentSessionNotFound>()(
  "AgentSessionNotFound",
  {},
  { httpApiStatus: 404 },
) {}

export class CreateAgentSessionError extends Schema.TaggedErrorClass<CreateAgentSessionError>()(
  "CreateAgentSessionError",
  {},
  { httpApiStatus: 500 },
) {}

export class MissingUploads extends Schema.TaggedErrorClass<MissingUploads>()(
  "MissingUploads",
  { missingKeys: Schema.Array(Schema.String) },
  { httpApiStatus: 400 },
) {}

export class ConfirmUploadError extends Schema.TaggedErrorClass<ConfirmUploadError>()(
  "ConfirmUploadError",
  {},
  { httpApiStatus: 500 },
) {}

export class SessionStateError extends Schema.TaggedErrorClass<SessionStateError>()(
  "SessionStateError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class AnalysisPipelineError extends Schema.TaggedErrorClass<AnalysisPipelineError>()(
  "AnalysisPipelineError",
  {},
  { httpApiStatus: 500 },
) {}

export class ConfirmAnalysisError extends Schema.TaggedErrorClass<ConfirmAnalysisError>()(
  "ConfirmAnalysisError",
  {},
  { httpApiStatus: 500 },
) {}

export class OutputNotFoundError extends Schema.TaggedErrorClass<OutputNotFoundError>()(
  "OutputNotFoundError",
  {},
  { httpApiStatus: 404 },
) {}

export class RevisionError extends Schema.TaggedErrorClass<RevisionError>()(
  "RevisionError",
  {},
  { httpApiStatus: 500 },
) {}
