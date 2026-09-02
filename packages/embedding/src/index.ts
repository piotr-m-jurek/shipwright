import { ConfigService } from "@shipwright/config";
import { Spans } from "@shipwright/observability";
import { Context, Effect, Layer, pipe, Schema } from "effect";
import { AiError, EmbeddingModel } from "effect/unstable/ai";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

// ----- Custom EmbeddingModel layer backed by HF Text Embeddings Inference -----

const TeiEmbedResponse = Schema.Array(Schema.Array(Schema.Finite));

export const HuggingFaceTeiEmbeddingModelLayer: Layer.Layer<
  EmbeddingModel.EmbeddingModel,
  never,
  ConfigService | HttpClient.HttpClient
> = Layer.effect(
  EmbeddingModel.EmbeddingModel,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const client = yield* HttpClient.HttpClient;
    const teiUrl = config.ai.teiUrl;

    return yield* EmbeddingModel.make({
      embedMany: ({ inputs }) =>
        pipe(
          HttpClientRequest.post(`${teiUrl}/embed`),
          HttpClientRequest.bodyJsonUnsafe({ inputs }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(TeiEmbedResponse)),
          Effect.map((results) => ({
            results: results as number[][],
            usage: { inputTokens: undefined },
          })),
          Effect.mapError((cause) =>
            AiError.make({
              module: "HuggingFaceTeiEmbeddingModel",
              method: "embedMany",
              reason: new AiError.InternalProviderError({
                description: `TEI request failed: ${String(cause)}`,
              }),
            }),
          ),
        ),
    });
  }),
);

export const HuggingFaceTeiEmbeddingModelLayerProvided = pipe(
  HuggingFaceTeiEmbeddingModelLayer,
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ConfigService.layer),
);

export class EmbeddingError extends Schema.TaggedError<EmbeddingError>()(
  "shipwright/agent/EmbeddingService/EmbeddingError",
  { cause: Schema.Defect() },
) {}

interface Interface {
  embedChunks: (chunks: string[]) => Effect.Effect<(readonly number[])[], EmbeddingError>;
  embedText: (text: string) => Effect.Effect<readonly number[], EmbeddingError>;
}

export class EmbeddingService extends Context.Service<EmbeddingService, Interface>()(
  "@shipwright/api/src/agent/EmbeddingService",
) {
  static readonly layer = Layer.effect(
    EmbeddingService,
    Effect.gen(function* () {
      const model = yield* EmbeddingModel.EmbeddingModel;

      const embedChunks = Effect.fn("EmbedChunks")(function* (chunks: string[]) {
        const res = yield* pipe(
          model.embedMany(chunks),
          Effect.mapError((cause) => new EmbeddingError({ cause })),
        );
        yield* Effect.annotateCurrentSpan(
          Spans.embedding({
            provider: "huggingface-tei",
            chunkCount: chunks.length,
            vectorDimensions: res.embeddings[0]?.vector.length ?? 0,
            inputTokens: res.usage.inputTokens,
          }),
        );
        return res.embeddings.map(({ vector }) => vector);
      });

      const embedText = Effect.fn("EmbedText")(function* (text: string) {
        const res = yield* pipe(
          model.embed(text),
          Effect.mapError((cause) => new EmbeddingError({ cause })),
        );
        yield* Effect.annotateCurrentSpan(
          Spans.embedding({
            provider: "huggingface-tei",
            textLength: text.length,
            vectorDimensions: res.vector.length,
          }),
        );
        return res.vector;
      });

      return { embedChunks, embedText };
    }),
  );
}
