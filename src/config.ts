import type { MigrationConfig } from "drizzle-orm/migrator";

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

const migrationConfig: MigrationConfig = {
  migrationsFolder: "./src/db/out",
};

type APIConfig = {
  db: DBConfig;
  storage: StorageConfig;
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
};

function envOrThrow(key: string) {
  const raw = process.env[key];
  if (!raw) {
    throw new Error(`Missing env variable ${key}`);
  }
  return raw;
}
