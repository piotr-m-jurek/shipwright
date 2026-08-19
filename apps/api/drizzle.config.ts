import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

config({ path: ".env" });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  schema: ["../../packages/db/src/schema.ts", "src/queue/schema.ts"],
  out: "src/db/out/",
  dialect: "postgresql",
  dbCredentials: { url },
});
