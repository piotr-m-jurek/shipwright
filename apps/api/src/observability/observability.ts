import { Effect, Layer, Option, Redacted } from "effect";
import { ConfigService } from "../config/config";
import { OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

/**
 * Sends traces and metrics to Langfuse's OTLP endpoint.
 *
 * Langfuse v3 returns 200 for /v1/traces (primary use-case: LLM spans) and
 * 200 for /v1/metrics (accepted, not surfaced in UI yet).
 * It returns 404 for /v1/logs, which would trigger OtlpExporter's 60-second
 * circuit breaker on every startup. Logs are therefore omitted intentionally.
 */
export const OtlpLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ConfigService;
    return Option.match(config.observability, {
      onNone: () => Layer.empty,
      onSome: ({ otlpEndpoint, publicKey, secretKey }) => {
        const credentials = btoa(`${Redacted.value(publicKey)}:${Redacted.value(secretKey)}`);
        const shared = {
          resource: { serviceName: "shipwright", serviceVersion: "1.0.0" },
          headers: {
            Authorization: `Basic ${credentials}`,
            "x-langfuse-ingestion-version": "4",
          },
        };
        return Layer.mergeAll(
          OtlpTracer.layer({ url: `${otlpEndpoint}/v1/traces`, ...shared }),
          OtlpMetrics.layer({ url: `${otlpEndpoint}/v1/metrics`, ...shared }),
        ).pipe(Layer.provide(OtlpSerialization.layerJson));
      },
    });
  }),
);
