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
import { ConfigService } from "@shipwright/config";

// ── Prompt names ───────────────────────────────────────────────────────────

/** All prompt names managed in Langfuse. Adding a name here is the only
 *  change needed to make it fetchable — the compiler enforces valid names
 *  at every call site via the PromptName type. */
export const PROMPT_NAMES = [
  "shipwright-challenger",
  "shipwright-brief",
  "shipwright-prd",
  "shipwright-summarizer",
  "shipwright-question-generator",
  "shipwright-revision-brief",
  "shipwright-revision-prd",
  "shipwright-score-completeness",
] as const;

export const PromptName = Schema.Literals(PROMPT_NAMES);
export type PromptName = typeof PromptName.Type;

// ── Errors ─────────────────────────────────────────────────────────────────

export class PromptFetchError extends Schema.TaggedError<PromptFetchError>()(
  "shipwright/observability/PromptFetchError",
  { name: Schema.String, cause: Schema.Defect() },
) {}

export class PromptParseError extends Schema.TaggedError<PromptParseError>()(
  "shipwright/observability/PromptParseError",
  { name: Schema.String, cause: Schema.Defect() },
) {}

// ── Response schema ────────────────────────────────────────────────────────

const LangfusePromptResponse = Schema.Struct({
  prompt: Schema.Unknown, // string for text prompts, array for chat prompts
  version: Schema.Finite,
  name: Schema.String,
});

const LangfuseDatasetResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const LangfuseDatasetItemResponse = Schema.Struct({
  id: Schema.String,
});

const LangfuseDatasetRunItemResponse = Schema.Struct({
  id: Schema.String,
});

// ── Result type ────────────────────────────────────────────────────────────

export class PromptResult extends Schema.Class<PromptResult>("PromptResult")({
  text: Schema.String,
  version: Schema.Finite,
  name: PromptName,
}) {}

// ── Score submission ───────────────────────────────────────────────────────

export class ScoreSubmitError extends Schema.TaggedError<ScoreSubmitError>()(
  "shipwright/observability/ScoreSubmitError",
  { traceId: Schema.String, name: Schema.String, cause: Schema.Defect() },
) {}

export interface ScoreInput {
  /** The OTLP trace ID to attach the score to. */
  readonly traceId: string;
  /** Score name — e.g. "faithfulness", "completeness". */
  readonly name: string;
  /** Numeric score value. */
  readonly value: number;
  /** Optional human-readable comment. */
  readonly comment?: string;
  /** Optional observation ID for span-level scores. */
  readonly observationId?: string;
}

// ── Dataset registration ──────────────────────────────────────────────────

export class DatasetError extends Schema.TaggedError<DatasetError>()(
  "shipwright/observability/DatasetError",
  { operation: Schema.String, name: Schema.String, cause: Schema.Defect() },
) {}

export interface CreateDatasetInput {
  readonly name: string;
  readonly description?: string;
}

export interface CreateDatasetItemInput {
  readonly datasetName: string;
  /** Stable id — dataset items are upserted on this, so re-running registration is idempotent. */
  readonly id: string;
  readonly input: unknown;
  readonly expectedOutput?: unknown;
  readonly metadata?: unknown;
}

export interface CreateDatasetRunItemInput {
  /** Groups run items together into one Run in the Langfuse UI. */
  readonly runName: string;
  /** The dataset item (registered via createDatasetItem) this run result is for. */
  readonly datasetItemId: string;
  /** The trace carrying the score(s) for this run — submit via submitScore first. */
  readonly traceId: string;
  readonly observationId?: string;
  readonly runDescription?: string;
}

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

  /**
   * Submit a numeric score to Langfuse against a specific trace (and
   * optionally a specific observation/span).
   *
   * No-ops silently when Langfuse is not configured. Logs and swallows
   * errors so score failures never break the calling pipeline.
   */
  submitScore: (input: ScoreInput) => Effect.Effect<void>;

  /**
   * Create (or update, if a dataset with this name already exists — the
   * Langfuse API upserts by name) a dataset to hold eval corpus cases.
   *
   * Fails with DatasetError when Langfuse is not configured or the request
   * fails — unlike getPrompt/submitScore, this is provisioning tooling, not
   * a runtime code path, so failures should be visible rather than
   * swallowed into a silent fallback.
   */
  createDataset: (input: CreateDatasetInput) => Effect.Effect<{ id: string; name: string }, DatasetError>;

  /**
   * Create (or update, since items are upserted on `id`) a dataset item.
   */
  createDatasetItem: (
    input: CreateDatasetItemInput,
  ) => Effect.Effect<{ id: string }, DatasetError>;

  /**
   * Link a trace (already carrying its score(s) via submitScore) to a
   * dataset item under a named run — this is what makes the run show up in
   * the Dataset's Runs tab in the Langfuse UI, enabling regression tracking
   * across runs over time.
   *
   * Fails loud like createDataset/createDatasetItem — this is eval-runner
   * reporting, not a runtime code path, so failures should be visible.
   */
  createDatasetRunItem: (
    input: CreateDatasetRunItemInput,
  ) => Effect.Effect<{ id: string }, DatasetError>;
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
          submitScore: (_input) => Effect.void,
          createDataset: (input) =>
            new DatasetError({
              operation: "createDataset",
              name: input.name,
              cause: "Langfuse not configured",
            }),
          createDatasetItem: (input) =>
            new DatasetError({
              operation: "createDatasetItem",
              name: input.id,
              cause: "Langfuse not configured",
            }),
          createDatasetRunItem: (input) =>
            new DatasetError({
              operation: "createDatasetRunItem",
              name: input.runName,
              cause: "Langfuse not configured",
            }),
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

      const submitScore = (input: ScoreInput): Effect.Effect<void> =>
        Effect.gen(function* () {
          const url = `${baseUrl}/api/public/scores`;
          const body = JSON.stringify({
            traceId: input.traceId,
            name: input.name,
            value: input.value,
            dataType: "NUMERIC",
            ...(input.comment !== undefined ? { comment: input.comment } : {}),
            ...(input.observationId !== undefined ? { observationId: input.observationId } : {}),
          });

          yield* Effect.logDebug(`[LangfuseClient] submitting score "${input.name}"`).pipe(
            Effect.annotateLogs({ scoreName: input.name, traceId: input.traceId, value: input.value }),
          );

          const response = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("Authorization", `Basic ${auth}`),
            HttpClientRequest.bodyText(body, "application/json"),
            http.execute,
            Effect.mapError((cause) => new ScoreSubmitError({ traceId: input.traceId, name: input.name, cause })),
          );

          if (response.status < 200 || response.status >= 300) {
            yield* Effect.logWarning(
              `[LangfuseClient] score submission for "${input.name}" returned HTTP ${response.status}`,
            ).pipe(Effect.annotateLogs({ scoreName: input.name, traceId: input.traceId, status: response.status }));
          } else {
            yield* Effect.logDebug(
              `[LangfuseClient] score "${input.name}" submitted (value=${input.value})`,
            ).pipe(Effect.annotateLogs({ scoreName: input.name, traceId: input.traceId }));
          }
        }).pipe(
          Effect.catchTags({
            "shipwright/observability/ScoreSubmitError": (err: ScoreSubmitError) =>
              Effect.logError(
                `[LangfuseClient] network error submitting score "${input.name}"`,
                err.cause,
              ).pipe(Effect.annotateLogs({ scoreName: input.name, traceId: input.traceId })),
          }),
        );

      const createDataset = (input: CreateDatasetInput): Effect.Effect<{ id: string; name: string }, DatasetError> =>
        Effect.gen(function* () {
          const url = `${baseUrl}/api/public/v2/datasets`;
          const body = JSON.stringify({
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
          });

          yield* Effect.logDebug(`[LangfuseClient] creating dataset "${input.name}"`).pipe(
            Effect.annotateLogs({ datasetName: input.name }),
          );

          const response = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("Authorization", `Basic ${auth}`),
            HttpClientRequest.bodyText(body, "application/json"),
            http.execute,
            Effect.mapError(
              (cause) => new DatasetError({ operation: "createDataset", name: input.name, cause }),
            ),
          );

          if (response.status < 200 || response.status >= 300) {
            const responseBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
            return yield* new DatasetError({
              operation: "createDataset",
              name: input.name,
              cause: `HTTP ${response.status}: ${responseBody}`,
            });
          }

          const json = yield* HttpClientResponse.schemaBodyJson(LangfuseDatasetResponse)(
            response,
          ).pipe(
            Effect.mapError(
              (cause) => new DatasetError({ operation: "createDataset", name: input.name, cause }),
            ),
          );

          yield* Effect.logInfo(
            `[LangfuseClient] dataset "${input.name}" ready (id=${json.id})`,
          ).pipe(Effect.annotateLogs({ datasetName: input.name, datasetId: json.id }));

          return json;
        });

      const createDatasetItem = (
        input: CreateDatasetItemInput,
      ): Effect.Effect<{ id: string }, DatasetError> =>
        Effect.gen(function* () {
          const url = `${baseUrl}/api/public/dataset-items`;
          const body = JSON.stringify({
            datasetName: input.datasetName,
            id: input.id,
            input: input.input,
            ...(input.expectedOutput !== undefined ? { expectedOutput: input.expectedOutput } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          });

          yield* Effect.logDebug(`[LangfuseClient] creating dataset item "${input.id}"`).pipe(
            Effect.annotateLogs({ datasetName: input.datasetName, itemId: input.id }),
          );

          const response = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("Authorization", `Basic ${auth}`),
            HttpClientRequest.bodyText(body, "application/json"),
            http.execute,
            Effect.mapError(
              (cause) => new DatasetError({ operation: "createDatasetItem", name: input.id, cause }),
            ),
          );

          if (response.status < 200 || response.status >= 300) {
            const responseBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
            return yield* new DatasetError({
              operation: "createDatasetItem",
              name: input.id,
              cause: `HTTP ${response.status}: ${responseBody}`,
            });
          }

          const json = yield* HttpClientResponse.schemaBodyJson(LangfuseDatasetItemResponse)(
            response,
          ).pipe(
            Effect.mapError(
              (cause) => new DatasetError({ operation: "createDatasetItem", name: input.id, cause }),
            ),
          );

          yield* Effect.logInfo(`[LangfuseClient] dataset item "${input.id}" ready`).pipe(
            Effect.annotateLogs({ datasetName: input.datasetName, itemId: input.id }),
          );

          return json;
        });

      const createDatasetRunItem = (
        input: CreateDatasetRunItemInput,
      ): Effect.Effect<{ id: string }, DatasetError> =>
        Effect.gen(function* () {
          const url = `${baseUrl}/api/public/dataset-run-items`;
          const body = JSON.stringify({
            runName: input.runName,
            datasetItemId: input.datasetItemId,
            traceId: input.traceId,
            ...(input.observationId !== undefined ? { observationId: input.observationId } : {}),
            ...(input.runDescription !== undefined ? { runDescription: input.runDescription } : {}),
          });

          yield* Effect.logDebug(
            `[LangfuseClient] linking dataset item "${input.datasetItemId}" to run "${input.runName}"`,
          ).pipe(
            Effect.annotateLogs({
              runName: input.runName,
              datasetItemId: input.datasetItemId,
              traceId: input.traceId,
            }),
          );

          const response = yield* HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("Authorization", `Basic ${auth}`),
            HttpClientRequest.bodyText(body, "application/json"),
            http.execute,
            Effect.mapError(
              (cause) =>
                new DatasetError({ operation: "createDatasetRunItem", name: input.runName, cause }),
            ),
          );

          if (response.status < 200 || response.status >= 300) {
            const responseBody = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
            return yield* new DatasetError({
              operation: "createDatasetRunItem",
              name: input.runName,
              cause: `HTTP ${response.status}: ${responseBody}`,
            });
          }

          const json = yield* HttpClientResponse.schemaBodyJson(LangfuseDatasetRunItemResponse)(
            response,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new DatasetError({ operation: "createDatasetRunItem", name: input.runName, cause }),
            ),
          );

          yield* Effect.logInfo(
            `[LangfuseClient] run "${input.runName}" linked to dataset item "${input.datasetItemId}"`,
          ).pipe(Effect.annotateLogs({ runName: input.runName, datasetItemId: input.datasetItemId }));

          return json;
        });

      return LangfuseClient.of({
        getPrompt,
        submitScore,
        createDataset,
        createDatasetItem,
        createDatasetRunItem,
      });
    }),
  );
}
