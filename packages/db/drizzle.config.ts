import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

config({ path: ".env" });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  schema: ["./src/schema.ts", "../queue/src/schema.ts"],
  out: "migrations/",
  dialect: "postgresql",
  dbCredentials: { url },
});
