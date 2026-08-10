/**
 * LangfuseClient — thin Effect service for Langfuse REST API calls.
 *
 * Deliberately not using the @langfuse/client SDK to avoid a new dependency
 * and keep all LLM calls going through @effect/ai (Architecture Rule 1).
 *
 * Prompt names are validated at compile time via PromptName literals.
 * Fetches are lazy (on first use) so prompt edits in the Langfuse UI take
 * effect on the next session without a redeploy.
 * Every fetch outcome is logged so missing prompts are never silent.
 */

import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ConfigService } from "../config/config";

// ── Prompt names ───────────────────────────────────────────────────────────

/** All prompt names managed in Langfuse. Adding a name here is the only
 *  change needed to make it fetchable — the compiler enforces valid names
 *  at every call site via the PromptName type. */
export const PROMPT_NAMES = [
  "shipwright-challenger",
  "shipwright-brief",
  "shipwright-prd",
] as const;

export const PromptName = Schema.Literals(PROMPT_NAMES);
export type PromptName = typeof PromptName.Type;

// ── Errors ─────────────────────────────────────────────────────────────────

export class PromptFetchError extends Schema.TaggedErrorClass<PromptFetchError>()(
  "shipwright/observability/PromptFetchError",
  { name: Schema.String, cause: Schema.Defect() },
) {}

export class PromptParseError extends Schema.TaggedErrorClass<PromptParseError>()(
  "shipwright/observability/PromptParseError",
  { name: Schema.String, cause: Schema.Defect() },
) {}

// ── Response schema ────────────────────────────────────────────────────────

const LangfusePromptResponse = Schema.Struct({
  prompt: Schema.Unknown, // string for text prompts, array for chat prompts
  version: Schema.Finite,
  name: Schema.String,
});

// ── Result type ────────────────────────────────────────────────────────────

export class PromptResult extends Schema.Class<PromptResult>("PromptResult")({
  text: Schema.String,
  version: Schema.Finite,
  name: PromptName,
}) {}

// ── Service ────────────────────────────────────────────────────────────────

interface Interface {
  /**
   * Fetch the production-labelled text prompt from Langfuse by name.
   *
   * Only accepts validated PromptName values — unknown names are a compile
   * error. Returns Option.none() when Langfuse is not configured, the prompt
   * does not exist, or the request fails. Every outcome is logged; callers
   * should use their hardcoded fallback when they receive Option.none().
   */
  getPrompt: (name: PromptName) => Effect.Effect<Option.Option<PromptResult>>;
}

export class LangfuseClient extends Context.Service<LangfuseClient, Interface>()(
  "shipwright/observability/LangfuseClient",
) {
  static readonly layer = Layer.effect(
    LangfuseClient,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const http = yield* HttpClient.HttpClient;

      if (Option.isNone(config.observability)) {
        yield* Effect.logInfo(
          "[LangfuseClient] observability not configured — prompt registry disabled, using hardcoded fallbacks",
        );
        return LangfuseClient.of({
          getPrompt: (name) =>
            Effect.logDebug(
              `[LangfuseClient] skipping prompt fetch for "${name}" — no Langfuse config`,
            ).pipe(Effect.as(Option.none())),
        });
      }

      const { otlpEndpoint, publicKey, secretKey } = config.observability.value;

      // Derive Langfuse REST base URL from the OTLP endpoint.
      // OTLP endpoint: http://localhost:3001/api/public/otel
      // REST base URL: http://localhost:3001
      const baseUrl = otlpEndpoint.replace(/\/api\/public\/otel\/?$/, "");
      const auth = btoa(`${Redacted.value(publicKey)}:${Redacted.value(secretKey)}`);

      const getPrompt = (name: PromptName): Effect.Effect<Option.Option<PromptResult>> =>
        Effect.gen(function* () {
          const url = `${baseUrl}/api/public/v2/prompts/${encodeURIComponent(name)}?label=production`;

          yield* Effect.logDebug(`[LangfuseClient] fetching prompt "${name}"`).pipe(
            Effect.annotateLogs({ promptName: name, url }),
          );

          const response = yield* HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("Authorization", `Basic ${auth}`),
            http.execute,
            Effect.mapError((cause) => new PromptFetchError({ name, cause })),
          );

          if (response.status === 404) {
            yield* Effect.logWarning(
              `[LangfuseClient] prompt "${name}" not found in registry — using hardcoded fallback. ` +
                `Create it at ${baseUrl}/prompts with label=production.`,
            ).pipe(Effect.annotateLogs({ promptName: name }));
            return Option.none<PromptResult>();
          }

          if (response.status < 200 || response.status >= 300) {
            yield* Effect.logWarning(
              `[LangfuseClient] prompt "${name}" fetch returned HTTP ${response.status} — using hardcoded fallback`,
            ).pipe(Effect.annotateLogs({ promptName: name, status: response.status }));
            return Option.none<PromptResult>();
          }

          const json = yield* HttpClientResponse.schemaBodyJson(LangfusePromptResponse)(
            response,
          ).pipe(Effect.mapError((cause) => new PromptParseError({ name, cause })));

          if (typeof json.prompt !== "string") {
            yield* Effect.logWarning(
              `[LangfuseClient] prompt "${name}" is a chat prompt (array), expected text — using hardcoded fallback`,
            ).pipe(Effect.annotateLogs({ promptName: name }));
            return Option.none<PromptResult>();
          }

          yield* Effect.logInfo(
            `[LangfuseClient] prompt "${name}" fetched (version ${json.version})`,
          ).pipe(Effect.annotateLogs({ promptName: name, version: json.version }));

          return Option.some(new PromptResult({ text: json.prompt, version: json.version, name }));
        }).pipe(
          Effect.catchTags({
            "shipwright/observability/PromptFetchError": (err: PromptFetchError) =>
              Effect.logError(
                `[LangfuseClient] network error fetching prompt "${name}" — using hardcoded fallback`,
                err.cause,
              ).pipe(
                Effect.annotateLogs({ promptName: name }),
                Effect.as(Option.none<PromptResult>()),
              ),
            "shipwright/observability/PromptParseError": (err: PromptParseError) =>
              Effect.logError(
                `[LangfuseClient] failed to parse prompt "${name}" response — using hardcoded fallback`,
                err.cause,
              ).pipe(
                Effect.annotateLogs({ promptName: name }),
                Effect.as(Option.none<PromptResult>()),
              ),
          }),
        );

      return LangfuseClient.of({ getPrompt });
    }),
  );
}
