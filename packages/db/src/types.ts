import type {
  agentSessions,
  answers,
  chunks,
  documents,
  documentSummaries,
  mcpTokens,
  outputs,
  questions,
  summaryItems,
} from "./schema";

export type SessionInsert = typeof agentSessions.$inferInsert;
export type SessionSelect = typeof agentSessions.$inferSelect;

export type InsertAgentSession = typeof agentSessions.$inferInsert;
export type SelectAgentSession = typeof agentSessions.$inferSelect;

export type InsertDocument = typeof documents.$inferInsert;
export type SelectDocument = typeof documents.$inferSelect;

export type InsertChunk = typeof chunks.$inferInsert;
export type SelectChunk = typeof chunks.$inferSelect;

export type DocumentSummaryInsert = typeof documentSummaries.$inferInsert;
export type DocumentSummarySelect = typeof documentSummaries.$inferSelect;

export type SummaryItemInsert = typeof summaryItems.$inferInsert;
export type SummaryItemSelect = typeof summaryItems.$inferSelect;

export type OutputInsert = typeof outputs.$inferInsert;
export type OutputSelect = typeof outputs.$inferSelect;

export type QuestionInsert = typeof questions.$inferInsert;
export type QuestionSelect = typeof questions.$inferSelect;
export type AnswerInsert = typeof answers.$inferInsert;
export type AnswerSelect = typeof answers.$inferSelect;

export type McpTokenInsert = typeof mcpTokens.$inferInsert;
export type McpTokenSelect = typeof mcpTokens.$inferSelect;
