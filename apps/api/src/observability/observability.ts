import { Effect, Layer, pipe, Redacted } from "effect";
import { ConfigService } from "../config/config.js";
import { Otlp } from "effect/unstable/observability";
import { FetchHttpClient } from "effect/unstable/http";

export const OtlpLayer = pipe(
  ConfigService,
  Effect.map((config) => {
    if (!config.observability) return Layer.empty;

    const { otlpEndpoint, publicKey, secretKey } = config.observability;

    const auth = btoa(`${Redacted.value(publicKey)}:${Redacted.value(secretKey)}`);

    return Otlp.layerJson({
      baseUrl: otlpEndpoint,
      headers: {
        Authorization: `Basic ${auth}`,
        "x-langfuse-ingestion-version": "4",
      },
      resource: {
        serviceName: "shipwright",
        serviceVersion: "0.1.0",
      },
    });
  }),
  Layer.unwrap,
  Layer.provide(ConfigService.layer),
  Layer.provide(FetchHttpClient.layer),
);
