import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";
import { relations } from "./schema.js";
import {PgClient} from '@effect/sql-pg;

// INFO:
// instead of having this as a migration that runs every time this file is imported somewhere
// we can have the migration ran with:
// - drizzle-kit generate & drizzle-kit migrate (create migration files and migrate DB)
// - drizzle-kit push (don't create migration files, just change the schema live)
//
// const migrationClient = postgres(config.db.url, { max: 1 });
// await migrate(drizzle({ client: migrationClient }), config.db.migrationConfig);

const client = postgres(config.db.url, { max: 1 });

export const db = drizzle({ client, relations, schema });
