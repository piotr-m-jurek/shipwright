/**
 * Shared Better Auth singleton — used by both @shipwright/api and
 * @shipwright/mcp so a session token issued by one is valid on the other
 * without a second betterAuth() config or a duplicate DB connection.
 *
 * Moved from apps/api/src/auth/auth.ts (SHIP-115 / SHIP-156).
 *
 * Auth table definitions (users, sessions, accounts, verifications) live in
 * @shipwright/db/schema, not here — that package is the single owner of the
 * full relational schema for this database (agentSessions.userId is a live
 * foreign key into users, so the two must share one defineRelations() call).
 * This dependency points auth -> db, never the reverse. Extra unrelated
 * tables in the imported namespace (agentSessions, documents, etc.) are
 * harmless — drizzleAdapter only looks up the table names it needs.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shipwright/db/schema";

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
