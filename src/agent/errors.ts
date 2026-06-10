import { Schema } from "effect";

export class TextGenerationError extends Schema.TaggedErrorClass<TextGenerationError>()(
  "TextGenerationError",
  { cause: Schema.Defect() },
) {}

export class EmbedChunksError extends Schema.TaggedErrorClass<EmbedChunksError>()(
  "EmbedChunksError",
  {
    cause: Schema.Defect(),
  },
) {}
