import { Effect, pipe } from "effect";
import { EmbedChunksError } from "./errors.js";
import { EmbeddingModel } from "effect/unstable/ai";
import { OpenAiEmbeddingModel } from "@effect/ai-openai";
import { OpenAiClientLayer } from "./providers.js";

export const embedChunks = Effect.fn("agent/embed-chunks")(function* (chunks: string[]) {
  // TODO: embedMany has a default batch limit
  const model = yield* EmbeddingModel.EmbeddingModel;

  const res = yield* pipe(
    model.embedMany(chunks),
    Effect.mapError((cause) => new EmbedChunksError({ cause })),
  );
  return res.embeddings.map(({ vector }) => vector);
},
Effect.provide(OpenAiEmbeddingModel.model("text-embedding-3-small", { dimensions: 1536 })),
Effect.provide(OpenAiClientLayer));
