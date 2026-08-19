import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Effect, Layer, pipe } from "effect";
import "@effect/ai-anthropic/AnthropicLanguageModel";
import { FetchHttpClient } from "effect/unstable/http";
import { ConfigService } from "@shipwright/config";

export const AnthropicClientLayer = pipe(
  ConfigService,
  Effect.map((config) => AnthropicClient.layer({ apiKey: config.ai.anthropicApiKey })),
  Layer.unwrap,
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ConfigService.layer),
);

// ── Named model layers ────────────────────────────────────────────────────
// All .model() calls live here. Writers receive these via Effect.provide().

export const AnthropicHaikuModelLayer = AnthropicLanguageModel.model("claude-haiku-4-5");
export const AnthropicSonnetModelLayer = AnthropicLanguageModel.model("claude-sonnet-4-6");

// The HuggingFace TEI EmbeddingModel layer lives in @shipwright/embedding —
// apps/mcp needs it too and apps can't depend on other apps.
