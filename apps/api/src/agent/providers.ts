import { AnthropicClient } from "@effect/ai-anthropic";
import { Effect, Layer, pipe, Schema } from "effect";
import { AiError, EmbeddingModel } from "effect/unstable/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ConfigService } from "../config/config.js";

export const AnthropicClientLayer = pipe(
  ConfigService,
  Effect.map((config) => AnthropicClient.layer({ apiKey: config.ai.anthropicApiKey })),
  Layer.unwrap,
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ConfigService.layer),
);

// ----- TEI response schema -----

const TeiEmbedResponse = Schema.Array(Schema.Array(Schema.Number));

// ----- Custom EmbeddingModel layer backed by HF Text Embeddings Inference -----

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
            results,
            usage: { inputTokens: undefined },
          })),
          Effect.mapError(
            (cause) =>
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
