/**
 * Better Auth instance factory.
 *
 * Wrapped by AuthService (auth-service.ts) as a Context.Service — nothing
 * outside this package should call makeAuth or read process.env directly.
 * All configuration is passed in explicitly (sourced from ConfigService by
 * AuthService's layer), so this module has no env reads and no side effects
 * at import time.
 *
 * Auth table definitions (users, sessions, accounts, verifications) live in
 * @shipwright/db/schema, not here — that package is the single owner of the
 * full relational schema for this database (agentSessions.userId is a live
 * foreign key into users, so the two must share one defineRelations() call).
 * This dependency points auth -> db, never the reverse. Extra unrelated
 * tables in the imported namespace (agentSessions, documents, etc.) are
 * harmless — drizzleAdapter only looks up the table names it needs.
 *
 * makeAuth opens its own dedicated Postgres connection (via drizzle-orm's
 * plain node-postgres adapter, not the Effect-wrapped DB service) because
 * better-auth's drizzleAdapter calls it directly as promises, with no Effect
 * awareness — it can't consume the effect-postgres-flavored DB service.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shipwright/db/schema";

export interface AuthConfig {
  readonly databaseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly github?: { readonly clientId: string; readonly clientSecret: string } | undefined;
  readonly google?: { readonly clientId: string; readonly clientSecret: string } | undefined;
}

export const makeAuth = (config: AuthConfig) => {
  const authDb = drizzle({ connection: config.databaseUrl });

  return betterAuth({
    trustedOrigins: [...config.allowedOrigins],
    database: drizzleAdapter(authDb, { provider: "pg", usePlural: true, schema }),
    socialProviders: {
      ...(config.github !== undefined ? { github: config.github } : {}),
      ...(config.google !== undefined ? { google: config.google } : {}),
    },
  });
};

export type Auth = ReturnType<typeof makeAuth>;
