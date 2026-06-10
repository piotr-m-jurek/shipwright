import { embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
import { Effect } from "effect";
import { EmbedChunksError } from "./errors.js";

export const embedChunks = Effect.fn("agent/embed-chunks")(function* (chunks: string[]) {
  // TODO: embedMany has a default batch limit

  const result = yield* Effect.tryPromise({
    try: () =>
      embedMany({
        model: openai.embedding("text-embedding-3-small"),
        values: chunks,
      }),
    catch: (cause) => new EmbedChunksError({ cause }),
  });
  return result.embeddings;
});
