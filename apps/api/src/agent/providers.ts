import { AnthropicClient } from "@effect/ai-anthropic";
import { OpenAiClient } from "@effect/ai-openai";
import { Effect, Layer, pipe } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ConfigService } from "../config/config.js";

export const AnthropicClientLayer = pipe(
  ConfigService,
  Effect.map((config) => AnthropicClient.layer({ apiKey: config.ai.anthropicApiKey })),
  Layer.unwrap,
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ConfigService.layer),
);

export const OpenAiClientLayer = pipe(
  ConfigService,
  Effect.map((config) => OpenAiClient.layer({ apiKey: config.ai.openaiApiKey })),
  Layer.unwrap,
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ConfigService.layer),
);
