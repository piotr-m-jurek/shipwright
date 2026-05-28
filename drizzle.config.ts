import { defineConfig } from "drizzle-kit";
import { config } from "./src/config.js";

const dbConfig = defineConfig({
  schema: "src/db/schema.ts",
  out: "src/db/out/",
  dialect: "postgresql",
  dbCredentials: { url: config.db.url },
});

export default dbConfig;
