import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config, ConfigService } from "../config.js";
import * as schema from "./schema.js";
import { relations } from "./schema.js";
import { Context, Effect, Layer, pipe } from "effect";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as PgClientModule from "@effect/sql-pg/PgClient";
import { types } from "pg";

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

// ==================================================
// ==================================================
// ==================================================

type DBType = Effect.Success<ReturnType<typeof PgDrizzle.makeWithDefaults>>;

export class DB extends Context.Service<DB, DBType>()("shipwright/db/index/DB") {}

export const PgClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ConfigService;
    return PgClientModule.layer({
      url: config.db.url,
      types: {
        getTypeParser: (typeId, format) => {
          if ([1184, 1114, 1082, 1186, 1231, 1115, 1185, 1187, 1182].includes(typeId)) {
            return (val: any) => val;
          }
          return types.getTypeParser(typeId, format);
        },
      },
    });
  }),
);

// Composed: consumers only need to provide AppDBLayer
export const AppDBLayer = pipe(
  Layer.effect(DB, PgDrizzle.makeWithDefaults({ schema, relations })),
  Layer.provide(PgClientLive),
);
