import { Context, Effect, Layer, pipe, Schema } from "effect";
import { EmbeddingModel } from "effect/unstable/ai";

export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()(
  "shipwright/agent/EmbeddingService/EmbeddingError",
  { cause: Schema.Defect() },
) {}

interface Interface {
  embedChunks: (chunks: string[]) => Effect.Effect<(readonly number[])[], EmbeddingError>;
  embedText: (text: string) => Effect.Effect<readonly number[], EmbeddingError>;
}

export class EmbeddingService extends Context.Service<EmbeddingService, Interface>()(
  "Embeddingservice",
) {}

export const layer = Layer.effect(
  EmbeddingService,
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

    return { embedChunks, embedText };
  }),
);
