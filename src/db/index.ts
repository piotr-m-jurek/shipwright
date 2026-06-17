import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";
import { relations } from "./schema.js";

const migrationClient = postgres(config.db.url, { max: 1 });

await migrate(drizzle({ client: migrationClient }), config.db.migrationConfig);

const client = postgres(config.db.url, { max: 1 });

export const db = drizzle({ client, relations, schema });
