import { Effect, Layer, Redacted } from "effect";
import { ConfigService } from "../config/config.js";
import { Otlp } from "effect/unstable/observability";

export const OtlpLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ConfigService;
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
);
