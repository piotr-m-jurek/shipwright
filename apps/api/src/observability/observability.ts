import { Effect, Layer, Option, Redacted } from "effect";
import { ConfigService } from "../config/config.js";
import { Otlp } from "effect/unstable/observability";

export const OtlpLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ConfigService;
    return Option.match(config.observability, {
      onNone: () => Layer.empty,
      onSome: ({ otlpEndpoint, publicKey, secretKey }) => {
        const credentials = btoa(`${Redacted.value(publicKey)}:${Redacted.value(secretKey)}`);
        return Otlp.layerJson({
          baseUrl: otlpEndpoint,
          headers: {
            Authorization: `Basic ${credentials}`,
            "x-langfuse-ingestion-version": "4",
          },
          resource: {
            serviceName: "shipwright",
            serviceVersion: "0.1.0",
          },
        });
      },
    });
  }),
);
