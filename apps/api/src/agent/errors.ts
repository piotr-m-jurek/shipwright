import { Schema } from "effect";

export class TextGenerationError extends Schema.TaggedErrorClass<TextGenerationError>()(
  "shipwright/agent/TextGenerationError",
  { cause: Schema.Defect() },
) {}

export class EmbedChunksError extends Schema.TaggedErrorClass<EmbedChunksError>()(
  "shipwright/agent/EmbedChunksError",
  { cause: Schema.Defect() },
) {}
