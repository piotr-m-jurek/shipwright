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
