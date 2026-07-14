import type { MigrationConfig } from "drizzle-orm/migrator";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
type ConfigServiceInterface = {
  server: { allowedOrigins: readonly string[] };
  db: { url: Redacted.Redacted<string>; migrationConfig: MigrationConfig };
  storage: {
    endpoint: string;
    secretKey: Redacted.Redacted<string>;
    accessKey: Redacted.Redacted<string>;
    bucket: string;
    allowedOrigins: readonly string[];
  };
  ai: {
    openaiApiKey: Redacted.Redacted<string>;
    anthropicApiKey: Redacted.Redacted<string>;
  };
  observability:
    | {
        otlpEndpoint: string;
        publicKey: Redacted.Redacted<string>;
        secretKey: Redacted.Redacted<string>;
      }
    | undefined;
};

export class ConfigService extends Context.Service<ConfigService, ConfigServiceInterface>()(
  "shipwright/config/ConfigService",
) {
  static readonly layer = Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const observability = yield* Config.string("LANGFUSE_OTLP_ENDPOINT").pipe(
        Effect.map((otlpEndpoint) =>
          Effect.gen(function* () {
            return {
              otlpEndpoint,
              publicKey: yield* Config.redacted("LANGFUSE_PUBLIC_KEY"),
              secretKey: yield* Config.redacted("LANGFUSE_SECRET_KEY"),
            };
          }),
        ),
        Effect.option,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(undefined),
            onSome: (eff) => eff,
          }),
        ),
      );

      return {
        server: {
          allowedOrigins: yield* Config.schema(Config.Array(Schema.String), "ALLOWED_ORIGINS"),
        },
        db: {
          url: yield* Config.redacted("DATABASE_URL"),
          migrationConfig: {
            migrationsFolder: "./src/db/out",
          },
        },
        storage: {
          endpoint: yield* Config.string("S3_ENDPOINT"),
          secretKey: yield* Config.redacted("S3_SECRET_KEY"),
          accessKey: yield* Config.redacted("S3_ACCESS_KEY"),
          bucket: yield* Config.string("S3_BUCKET"),
          allowedOrigins: yield* Config.schema(Config.Array(Schema.String), "S3_ALLOWED_ORIGINS"),
        },
        ai: {
          openaiApiKey: yield* Config.redacted("OPENAI_API_KEY"),
          anthropicApiKey: yield* Config.redacted("ANTHROPIC_API_KEY"),
        },
        observability,
      };
    }),
  );
}
