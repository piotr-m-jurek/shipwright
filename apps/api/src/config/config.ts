import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
type Interface = {
  server: {
    allowedOrigins: readonly string[];
  };
  db: {
    url: Redacted.Redacted<string>;
  };
  storage: {
    endpoint: string;
    secretKey: Redacted.Redacted<string>;
    accessKey: Redacted.Redacted<string>;
    bucket: string;
    allowedOrigins: readonly string[];
  };
  ai: {
    teiUrl: string;
    anthropicApiKey: Redacted.Redacted<string>;
  };
  observability: Option.Option<{
    otlpEndpoint: string;
    publicKey: Redacted.Redacted<string>;
    secretKey: Redacted.Redacted<string>;
  }>;
};

export class ConfigService extends Context.Service<ConfigService, Interface>()(
  "shipwright/config/ConfigService",
) {
  static readonly layer = Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const observability: Interface["observability"] = yield* Config.option(
        Config.all({
          otlpEndpoint: Config.string("LANGFUSE_OTLP_ENDPOINT"),
          publicKey: Config.redacted("LANGFUSE_PUBLIC_KEY"),
          secretKey: Config.redacted("LANGFUSE_SECRET_KEY"),
        }),
      );

      const db: Interface["db"] = {
        url: yield* Config.redacted("DATABASE_URL"),
      };

      const server: Interface["server"] = {
        allowedOrigins: yield* Config.schema(Config.Array(Schema.String), "ALLOWED_ORIGINS"),
      };

      const storage: Interface["storage"] = {
        endpoint: yield* Config.string("S3_ENDPOINT"),
        secretKey: yield* Config.redacted("S3_SECRET_KEY"),
        accessKey: yield* Config.redacted("S3_ACCESS_KEY"),
        bucket: yield* Config.string("S3_BUCKET"),
        allowedOrigins: yield* Config.schema(Config.Array(Schema.String), "S3_ALLOWED_ORIGINS"),
      };

      const ai: Interface["ai"] = {
        teiUrl: yield* Config.string("TEI_URL"),
        anthropicApiKey: yield* Config.redacted("ANTHROPIC_API_KEY"),
      };

      return {
        server,
        db,
        storage,
        ai,
        observability,
      };
    }),
  );
}
