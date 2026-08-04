import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = new pg.Client({ connectionString: url });
await client.connect();

const db = drizzle({ client });

console.log("Running migrations...");
await migrate(db, { migrationsFolder: "./src/db/out" });
console.log("Migrations complete.");
