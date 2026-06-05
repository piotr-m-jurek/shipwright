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

export const sessionStatusEnum = pgEnum("session_status", [
  "idle",
  "uploading",
  "processing",
  "analyzing",
  "awaiting_answers",
  "re_evaluating",
  "generating",
  "complete",
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
  xstateSnapshot: jsonb("xstate_snapshot"), //.$type<{ state: string }>(),
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
  filename: text("filename").notNull(),
  documentType: documentTypeEnum("document_type").notNull(),
  storagePath: text("storage_path"),
  rawText: text("raw_text"),
  tokenCount: integer("token_count"),
  status: documentStatusEnum("document_status").notNull().default("pending"),
  // TODO: mimeType
  // TODO: size
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
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  // TODO: odnośnik do miejsca w dokumencie
  // Chapter2--H1/H2/H4.P427 <> json
  // or page number: number | null,
  //

  documentType: documentTypeEnum("document_type").notNull(),
});

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
    messages,
    questions,
    answers,
    outputs,
  },
  (r) => ({
    agentSessions: {
      documents: r.many.documents(),
      chunks: r.many.chunks(),
      messages: r.many.messages(),
      questions: r.many.questions(),
      answers: r.many.answers(),
      outputs: r.many.outputs(),
    },
    documents: {
      session: r.one.agentSessions({ from: r.documents.sessionId, to: r.agentSessions.id }),
      chunks: r.many.chunks(),
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
