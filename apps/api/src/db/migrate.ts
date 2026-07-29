import { drizzle } from "drizzle-orm/node-postgres";
import { Effect, Redacted } from "effect";
import { ConfigService } from "../config/config.js";
import pg from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const program = Effect.gen(function* () {
  const config = yield* ConfigService;
  const client = new pg.Client({ connectionString: Redacted.value(config.db.url) });
  yield* Effect.addFinalizer(() => Effect.promise(() => client.end()));
  const db = drizzle({ client: client });

  yield* Effect.promise(() => client.connect());

  yield* Effect.promise(() =>
    migrate(db, { migrationsFolder: config.db.migrationConfig.migrationsFolder }),
  );
});

Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(ConfigService.layer)));

/*
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = new pg.Client({ connectionString: url });
await client.connect();

const db = drizzle(client);

console.log("Running migrations...");
await migrate(db, { migrationsFolder: "./src/db/out" });
console.log("Migrations complete.");

*/
