/**
 * Centralized AI provider setup (architecture change, 2026-09-10) — the
 * single place any app/package in this repo goes for LanguageModel access.
 * Previously apps/api/src/agent/providers.ts, app-scoped so apps/mcp
 * couldn't reuse it (apps can't depend on other apps) — same reasoning
 * @shipwright/embedding already exists for EmbeddingModel.
 *
 * Callers never import a provider-specific layer or write their own
 * Layer.provideMerge(modelLayer, clientLayer) — they `yield* AiModels` and
 * call `.use(<model tag>)` on the effect that needs a LanguageModel, naming
 * the actual model they want by its real Ollama tag — not a vendor-borrowed
 * alias like "haiku"/"sonnet" (what this used to be called, back when both
 * tags happened to point at the same Anthropic model). Swapping the
 * underlying provider is still a change to this one file's
 * OllamaClientLayer/AiModels.make only — no call site imports a provider
 * package.
 *
 * Was Anthropic (both tags on claude-haiku-4-5) until 2026-09-11 — no more
 * Claude API access, switched to models running locally via Ollama. Ollama
 * exposes an OpenAI-compatible /v1 endpoint, so this uses @effect/ai-openai
 * pointed at OLLAMA_URL rather than a real OpenAI key — same shape any
 * other OpenAI-compatible provider (OpenRouter included) would use later.
 *
 * Two models, matching Rule 6's structured-vs-writing split:
 *   "llama3.1:8b"          fast, cheap — the structured passes
 *                           (summarizer/challenger/question-generator/judge/
 *                           writer-toolkit) that fire once per chunk or
 *                           once per document.
 *   "qwen2.5:14b-instruct" slower, stronger structured/JSON output — the
 *                           Brief/PRD/revision writers, one call per
 *                           document set.
 *
 * Both must already be pulled locally: `ollama pull llama3.1:8b` and
 * `ollama pull qwen2.5:14b-instruct`. `ollama serve` (or `brew services
 * start ollama`) must be running — there is no hosted fallback here.
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Context, Effect, Layer, pipe } from "effect";
import "@effect/ai-openai/OpenAiLanguageModel";
import { FetchHttpClient } from "effect/unstable/http";
import type { LanguageModel } from "effect/unstable/ai";
import type { ModelName, ProviderName } from "effect/unstable/ai/Model";
import { ConfigService } from "@shipwright/config";

export const OllamaClientLayer = pipe(
  ConfigService,
  Effect.map((config) => OpenAiClient.layer({ apiUrl: config.ai.ollamaUrl })),
  Layer.unwrap,
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ConfigService.layer),
);

export type ModelTag = "llama3.1:8b" | "qwen2.5:14b-instruct";

interface Interface {
  use: (
    model: ModelTag,
  ) => <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, LanguageModel.LanguageModel | ModelName | ProviderName>>;
}

export class AiModels extends Context.Service<AiModels, Interface>()("@shipwright/ai/AiModels") {
  static readonly layer = Layer.effect(
    AiModels,
    Effect.gen(function* () {
      const llama = yield* OpenAiLanguageModel.model("llama3.1:8b").captureRequirements;
      const qwen = yield* OpenAiLanguageModel.model("qwen2.5:14b-instruct").captureRequirements;

      const getModelLayer = (model: ModelTag) => (model === "llama3.1:8b" ? llama : qwen);

      return AiModels.of({
        use: (model) => (effect) => Effect.provide(effect, getModelLayer(model)),
      });
    }),
  ).pipe(Layer.provide(OllamaClientLayer));
}
