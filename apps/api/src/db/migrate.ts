import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = new pg.Client({ connectionString: url });
await client.connect();

const db = drizzle({ client });

// import.meta.dir is Bun-native and resolves correctly regardless of CWD
const migrationsFolder = path.join(import.meta.dir, "out");

console.log("Running migrations from:", migrationsFolder);
await migrate(db, { migrationsFolder });
console.log("Migrations complete.");

await client.end();
