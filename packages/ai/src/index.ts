/**
 * Centralized AI provider setup (architecture change, 2026-09-10) — the
 * single place any app/package in this repo goes for LanguageModel access.
 * Previously apps/api/src/agent/providers.ts, app-scoped so apps/mcp
 * couldn't reuse it (apps can't depend on other apps) — same reasoning
 * @shipwright/embedding already exists for EmbeddingModel.
 *
 * Callers never import a provider-specific layer (AnthropicClientLayer,
 * AnthropicHaikuModelLayer, ...) or write their own
 * Layer.provideMerge(modelLayer, clientLayer) — they `yield* AiModels` and
 * call `.use("haiku" | "sonnet")` on the effect that needs a LanguageModel.
 * Swapping the underlying provider (Anthropic -> OpenRouter, most likely
 * next) is a change to this one file's AnthropicClientLayer/AiModels.make
 * only — no call site anywhere in the repo references Anthropic by name.
 *
 * "haiku"/"sonnet" name a cost/quality TIER, not a literal model — Rule 6
 * (structured passes vs. writing passes) is why call sites need two tiers
 * at all. Both point at claude-haiku-4-5 today (temporary — the writers
 * were evaluated against real Sonnet, see the prior providers.ts comment
 * this superseded); left as-is per explicit instruction, not an oversight.
 */
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Context, Effect, Layer, pipe } from "effect";
import "@effect/ai-anthropic/AnthropicLanguageModel";
import { FetchHttpClient } from "effect/unstable/http";
import type { LanguageModel } from "effect/unstable/ai";
import type { ModelName, ProviderName } from "effect/unstable/ai/Model";
import { ConfigService } from "@shipwright/config";

export const AnthropicClientLayer = pipe(
  ConfigService,
  Effect.map((config) => AnthropicClient.layer({ apiKey: config.ai.anthropicApiKey })),
  Layer.unwrap,
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ConfigService.layer),
);

export type ModelTier = "haiku" | "sonnet";

interface Interface {
  use: (
    tier: ModelTier,
  ) => <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, LanguageModel.LanguageModel | ModelName | ProviderName>>;
}

export class AiModels extends Context.Service<AiModels, Interface>()("@shipwright/ai/AiModels") {
  static readonly layer = Layer.effect(
    AiModels,
    Effect.gen(function* () {
      const haiku = yield* AnthropicLanguageModel.model("claude-haiku-4-5").captureRequirements;
      const sonnet = yield* AnthropicLanguageModel.model("claude-haiku-4-5").captureRequirements;

      const getModelLayer = (tier: ModelTier) => (tier === "haiku" ? haiku : sonnet);

      return AiModels.of({
        use: (tier) => (effect) => Effect.provide(effect, getModelLayer(tier)),
      });
    }),
  ).pipe(Layer.provide(AnthropicClientLayer));
}
