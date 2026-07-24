import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import * as schema from "../db/schema.js";

import { authDb } from "./db.js";

export const auth = betterAuth({
  trustedOrigins: [process.env.ALLOWED_ORIGINS!],
  database: drizzleAdapter(authDb, {
    provider: "pg",
    usePlural: true,
    schema,
  }),

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
