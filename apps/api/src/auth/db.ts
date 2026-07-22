import { drizzle } from "drizzle-orm/node-postgres";

export const authDb = drizzle({ connection: process.env.DATABASE_URL! });
