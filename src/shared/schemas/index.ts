import { chunks, documents, agentSessions } from "../../db/schema.js";

export type InsertDocument = typeof documents.$inferInsert;
export type SelectDocument = typeof documents.$inferSelect;

export type InsertAgentSession = typeof agentSessions.$inferInsert;
export type SelectAgentSession = typeof agentSessions.$inferSelect;

export type InsertChunk = typeof chunks.$inferInsert;
export type SelectChunk = typeof chunks.$inferSelect;
