import type { MigrationConfig } from "drizzle-orm/migrator";
import { Config, Context, Effect, Layer, pipe, Redacted, Schema } from "effect";

process.loadEnvFile();

type DBConfig = {
  url: string;
  migrationConfig: MigrationConfig;
};

type StorageConfig = {
  endpoint: string;
  secretKey: string;
  accessKey: string;
  bucket: string;
};

type AIConfig = {
  openaiApiKey: string;
};

const migrationConfig: MigrationConfig = {
  migrationsFolder: "./src/db/out",
};

type APIConfig = {
  db: DBConfig;
  storage: StorageConfig;
  ai: AIConfig;
};

export const config: APIConfig = {
  db: {
    url: envOrThrow("DATABASE_URL"),
    migrationConfig,
  },
  storage: {
    endpoint: envOrThrow("S3_ENDPOINT"),
    secretKey: envOrThrow("S3_SECRET_KEY"),
    accessKey: envOrThrow("S3_ACCESS_KEY"),
    bucket: envOrThrow("S3_BUCKET"),
  },
  ai: {
    openaiApiKey: envOrThrow("OPENAI_API_KEY"),
  },
};

function envOrThrow(key: string) {
  const raw = process.env[key];
  if (!raw) {
    throw new Error(key);
  }
  return raw;
}

class EnvMissing extends Schema.TaggedErrorClass<EnvMissing>()("EnvMissing", {
  key: Schema.String,
}) {}

function envOrThrowEffect(key: string) {
  const raw = process.env[key];
  if (!raw) {
    throw new EnvMissing({ key });
  }
  return raw;
}

export class ConfigService extends Context.Service<
  ConfigService,
  {
    db: { url: Redacted.Redacted<string>; migrationConfig: MigrationConfig };
    storage: StorageConfig;
    ai: AIConfig;
  }
>()("shipwright/config/ConfigService") {
  static readonly layer = Layer.sync(ConfigService, () => ({
    db: {
      url: pipe(envOrThrowEffect("DATABASE_URL"), Redacted.make),
      migrationConfig,
    },
    storage: {
      endpoint: envOrThrowEffect("S3_ENDPOINT"),
      secretKey: envOrThrowEffect("S3_SECRET_KEY"),
      accessKey: envOrThrowEffect("S3_ACCESS_KEY"),
      bucket: envOrThrowEffect("S3_BUCKET"),
    },
    ai: {
      openaiApiKey: envOrThrow("OPENAI_API_KEY"),
    },
  }));
}
