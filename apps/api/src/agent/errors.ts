import { Schema } from "effect";

export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "shipwright/agent/TextGenerationError",
  { cause: Schema.Defect() },
) {}

export class EmbedChunksError extends Schema.TaggedError<EmbedChunksError>()(
  "shipwright/agent/EmbedChunksError",
  { cause: Schema.Defect() },
) {}

export class AnalysisPipelineError extends Schema.TaggedError<AnalysisPipelineError>()(
  "shipwright/agent/AnalysisPipelineError",
  { cause: Schema.Defect() },
) {}

export class AllExtractionsFailedError extends Schema.TaggedError<AllExtractionsFailedError>()(
  "shipwright/agent/AllExtractionsFailedError",
  {},
) {}
