import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { defineRelations } from "drizzle-orm";

import { createInsertSchema } from "drizzle-orm/zod";
import { MachineContext } from "../shared/schemas/machine.js";

export const sessionStatusEnum = pgEnum("session_status", [
  "idle",
  "uploading",
  "processing",
  "analyzing",
  "awaiting_answers",
  "re_evaluating",
  "generating",
  "complete",
  "revising",
  "error",
  "partial_error",
]);

export const inputModeEnum = pgEnum("input_mode", ["context", "retrieval"]);

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),

  status: sessionStatusEnum("status").notNull().default("idle"),
  inputMode: inputModeEnum("input_mode").notNull().default("context"),
  xstateSnapshot: jsonb("xstate_snapshot").$type<MachineContext>(),
});

export const sessionInsertSchema = createInsertSchema(agentSessions);
export type SessionInsert = typeof agentSessions.$inferInsert;
export type SessionSelect = typeof agentSessions.$inferSelect;

export const documentTypeEnum = pgEnum("document_type", [
  "transcript",
  "prd_draft",
  "rfp",
  "notes",
]);

export const documentStatusEnum = pgEnum("document_status", [
  "pending",
  "uploaded",
  "processing",
  "ready",
  "error",
]);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull(),
  documentType: documentTypeEnum("document_type").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  rawText: text("raw_text"),
  status: documentStatusEnum("document_status").notNull().default("pending"),
  storagePath: text("storage_path"),
  tokenCount: integer("token_count"),
});

export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull(),
  documentId: uuid("document_id")
    .references(() => documents.id, { onDelete: "cascade" })
    .notNull(),
  charOffset: integer("char_offset"),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  documentType: documentTypeEnum("document_type").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  headingPath: text("heading_path").array(),
  pageNumber: integer("page_number"),
});

export const summaryTypeEnum = pgEnum("summary_type", ["map_intermediate", "final"]);

export const confidenceLevelEnum = pgEnum("confidence_level", ["high", "medium", "low"]);

export const summaryItemTypeEnum = pgEnum("summary_item_type", [
  "requirement",
  "constraint",
  "assumption",
]);

export const documentSummaries = pgTable("document_summaries", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  documentId: uuid("document_id")
    .references(() => documents.id, { onDelete: "cascade" })
    .notNull(),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull(),
  // filename of the source document — denormalised for query convenience
  sourceDocument: text("source_document").notNull(),
  version: integer("version").notNull().default(1),
  summaryType: summaryTypeEnum("summary_type").notNull(),
  // for map_intermediate rows: which chunk produced this intermediate
  batchIndex: integer("batch_index"),
  // prose summary of the document content
  content: text("content").notNull(),
  // token count of content — used by XState tokensBelowThreshold guard
  tokenCount: integer("token_count").notNull(),
});

export type DocumentSummaryInsert = typeof documentSummaries.$inferInsert;
export type DocumentSummarySelect = typeof documentSummaries.$inferSelect;

export const summaryItems = pgTable("summary_items", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  summaryId: uuid("summary_id")
    .references(() => documentSummaries.id, { onDelete: "cascade" })
    .notNull(),
  itemType: summaryItemTypeEnum("item_type").notNull(),
  text: text("text").notNull(),
  sourceDocument: text("source_document").notNull(),
  confidence: confidenceLevelEnum("confidence").notNull(),
  orderIndex: integer("order_index").notNull(),
});

export type SummaryItemInsert = typeof summaryItems.$inferInsert;
export type SummaryItemSelect = typeof summaryItems.$inferSelect;

export const messageRoleEnum = pgEnum("role", ["user", "assistant", "system"]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull(),
  content: text("content").notNull(),
  role: messageRoleEnum("role").notNull(),
  agentPass: text("agent_pass"),
});

export const questions = pgTable("questions", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull(),
  text: text("text").notNull(),
  sourceDocuments: text("source_documents").array().notNull(),
  rationale: text("rationale").notNull(),
  orderIndex: integer("order_index").notNull(),
});

export const answers = pgTable("answers", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull(),
  questionId: uuid("question_id")
    .references(() => questions.id, { onDelete: "cascade" })
    .notNull(),
  text: text("text").notNull(),
  round: integer("round").notNull(),
});

export const outputTypeEnum = pgEnum("output_type", ["project_brief", "implementation_prd"]);

export const outputs = pgTable("outputs", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull(),
  type: outputTypeEnum().notNull(),
  content: text(),
  version: integer(),
});

export const relations = defineRelations(
  {
    agentSessions,
    documents,
    chunks,
    documentSummaries,
    summaryItems,
    messages,
    questions,
    answers,
    outputs,
  },
  (r) => ({
    agentSessions: {
      documents: r.many.documents(),
      chunks: r.many.chunks(),
      documentSummaries: r.many.documentSummaries(),
      messages: r.many.messages(),
      questions: r.many.questions(),
      answers: r.many.answers(),
      outputs: r.many.outputs(),
    },
    documents: {
      session: r.one.agentSessions({ from: r.documents.sessionId, to: r.agentSessions.id }),
      chunks: r.many.chunks(),
      summaries: r.many.documentSummaries(),
    },
    documentSummaries: {
      document: r.one.documents({ from: r.documentSummaries.documentId, to: r.documents.id }),
      session: r.one.agentSessions({ from: r.documentSummaries.sessionId, to: r.agentSessions.id }),
      items: r.many.summaryItems(),
    },
    summaryItems: {
      summary: r.one.documentSummaries({
        from: r.summaryItems.summaryId,
        to: r.documentSummaries.id,
      }),
    },
    chunks: {
      document: r.one.documents({ from: r.chunks.documentId, to: r.documents.id }),
      session: r.one.agentSessions({ from: r.chunks.sessionId, to: r.agentSessions.id }),
    },
    messages: {
      session: r.one.agentSessions({ from: r.messages.sessionId, to: r.agentSessions.id }),
    },
    questions: {
      session: r.one.agentSessions({ from: r.questions.sessionId, to: r.agentSessions.id }),
      answers: r.many.answers(),
    },
    answers: {
      session: r.one.agentSessions({ from: r.answers.sessionId, to: r.agentSessions.id }),
      question: r.one.questions({ from: r.answers.questionId, to: r.questions.id }),
    },
    outputs: {
      session: r.one.agentSessions({ from: r.outputs.sessionId, to: r.agentSessions.id }),
    },
  }),
);
