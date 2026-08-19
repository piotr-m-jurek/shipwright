/**
 * Shared Better Auth singleton — used by both @shipwright/api and
 * @shipwright/mcp so a session token issued by one is valid on the other
 * without a second betterAuth() config or a duplicate DB connection.
 *
 * Moved from apps/api/src/auth/auth.ts (SHIP-115 / SHIP-156).
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const authDb = drizzle({ connection: process.env.DATABASE_URL! });

export const auth = betterAuth({
  trustedOrigins: [process.env.ALLOWED_ORIGINS!],
  database: drizzleAdapter(authDb, { provider: "pg", usePlural: true, schema }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
});
