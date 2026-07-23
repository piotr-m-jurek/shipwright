import { Context, Effect, Layer, pipe, Schema } from "effect";
import { EmbeddingModel } from "effect/unstable/ai";

export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()(
  "shipwright/agent/ChunkingService/EmbeddingError",
  { cause: Schema.Defect() },
) {}

interface Interface {
  embedChunks: (chunks: string[]) => Effect.Effect<(readonly number[])[], EmbeddingError>;
  embedText: (text: string) => Effect.Effect<readonly number[], EmbeddingError>;
}

export class ChunkingService extends Context.Service<ChunkingService, Interface>()(
  "ChunkingService",
) {}

export const layer = Layer.effect(
  ChunkingService,
  Effect.gen(function* () {
    const model = yield* EmbeddingModel.EmbeddingModel;

    const embedChunks = Effect.fn("EmbedChunks")(function* (chunks) {
      const res = yield* pipe(
        model.embedMany(chunks),
        Effect.mapError((cause) => new EmbeddingError({ cause })),
      );
      return res.embeddings.map(({ vector }) => vector);
    });

    const embedText = Effect.fn("EmbedText")(function* (text) {
      const res = yield* pipe(
        model.embed(text),
        Effect.mapError((cause) => new EmbeddingError({ cause })),
      );
      return res.vector;
    });

    return {
      embedChunks,
      embedText,
    };
  }),
);
