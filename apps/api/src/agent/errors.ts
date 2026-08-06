import { Schema } from "effect";

export class TextGenerationError extends Schema.TaggedErrorClass<TextGenerationError>()(
  "shipwright/agent/TextGenerationError",
  { cause: Schema.Defect() },
) {}

export class EmbedChunksError extends Schema.TaggedErrorClass<EmbedChunksError>()(
  "shipwright/agent/EmbedChunksError",
  { cause: Schema.Defect() },
) {}

export class AnalysisPipelineError extends Schema.TaggedErrorClass<AnalysisPipelineError>()(
  "shipwright/agent/AnalysisPipelineError",
  { cause: Schema.Defect() },
) {}

export class SessionStateError extends Schema.TaggedErrorClass<SessionStateError>()(
  "shipwright/agent/SessionStateError",
  { message: Schema.String },
) {}

export class AllExtractionsFailedError extends Schema.TaggedErrorClass<AllExtractionsFailedError>()(
  "shipwright/agent/AllExtractionsFailedError",
  {},
) {}
