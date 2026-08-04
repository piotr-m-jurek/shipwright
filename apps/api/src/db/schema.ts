import {
  boolean,
  index,
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

import { type MachineContext } from "@shipwright/shared/schemas/machine.js";
import type {
  AgentSessionId,
  AnswerId,
  ChunkId,
  DocumentId,
  MessageId,
  OutputId,
  QuestionId,
  SummaryId,
  SummaryItemId,
} from "@shipwright/shared/domain/ids";

import { queueMessages } from "../queue/schema.ts";
export { queueMessages, queueMessageStatusEnum } from "../queue/schema.ts";

// ── Better Auth tables ────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("sessions_userId_idx").on(table.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("accounts_userId_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

export const sessionStatusEnum = pgEnum("session_status", [
  "idle",
  "uploading",
  "summarizing",
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
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<AgentSessionId>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),

  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  status: sessionStatusEnum("status").notNull().default("idle"),
  inputMode: inputModeEnum("input_mode").notNull().default("context"),
  xstateSnapshot: jsonb("xstate_snapshot").$type<MachineContext>(),
});

export const documentStatusEnum = pgEnum("document_status", [
  "pending",
  "uploaded",
  "processing",
  "ready",
  "error",
]);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<DocumentId>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull()
    .$type<AgentSessionId>(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  rawText: text("raw_text"),
  status: documentStatusEnum("document_status").notNull().default("pending"),
  storagePath: text("storage_path"),
  tokenCount: integer("token_count"),
});

export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<ChunkId>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull()
    .$type<AgentSessionId>(),
  documentId: uuid("document_id")
    .references(() => documents.id, { onDelete: "cascade" })
    .notNull()
    .$type<DocumentId>(),
  charOffset: integer("char_offset"),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
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
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<SummaryId>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  documentId: uuid("document_id")
    .references(() => documents.id, { onDelete: "cascade" })
    .notNull()
    .$type<DocumentId>(),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull()
    .$type<AgentSessionId>(),
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

export const summaryItems = pgTable("summary_items", {
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<SummaryItemId>(),
  summaryId: uuid("summary_id")
    .references(() => documentSummaries.id, { onDelete: "cascade" })
    .notNull()
    .$type<SummaryId>(),
  itemType: summaryItemTypeEnum("item_type").notNull(),
  text: text("text").notNull(),
  sourceDocument: text("source_document").notNull(),
  confidence: confidenceLevelEnum("confidence").notNull(),
  orderIndex: integer("order_index").notNull(),
});

export const messageRoleEnum = pgEnum("role", ["user", "assistant", "system"]);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<MessageId>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull()
    .$type<AgentSessionId>(),
  content: text("content").notNull(),
  role: messageRoleEnum("role").notNull(),
  agentPass: text("agent_pass"),
});

export const questions = pgTable("questions", {
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<QuestionId>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull()
    .$type<AgentSessionId>(),
  text: text("text").notNull(),
  sourceDocuments: text("source_documents").array().notNull(),
  rationale: text("rationale").notNull(),
  orderIndex: integer("order_index").notNull(),
});

export const answers = pgTable("answers", {
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<AnswerId>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull()
    .$type<AgentSessionId>(),
  questionId: uuid("question_id")
    .references(() => questions.id, { onDelete: "cascade" })
    .notNull()
    .$type<QuestionId>(),
  text: text("text").notNull(),
  round: integer("round").notNull(),
});

export const outputTypeEnum = pgEnum("output_type", ["project_brief", "implementation_prd"]);

export const outputs = pgTable("outputs", {
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<OutputId>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  sessionId: uuid("session_id")
    .references(() => agentSessions.id, { onDelete: "cascade" })
    .notNull()
    .$type<AgentSessionId>(),
  type: outputTypeEnum().notNull(),
  content: text(),
  version: integer(),
  // S3 key for presigned GET URL export — set when output is uploaded to storage
  s3Key: text("s3_key"),
});

export const relations = defineRelations(
  {
    users,
    sessions,
    accounts,
    verifications,
    agentSessions,
    documents,
    chunks,
    documentSummaries,
    summaryItems,
    messages,
    questions,
    answers,
    outputs,
    queueMessages,
  },
  (r) => ({
    users: {
      agentSessions: r.many.agentSessions(),
      sessions: r.many.sessions(),
      accounts: r.many.accounts(),
    },
    sessions: {
      user: r.one.users({ from: r.sessions.userId, to: r.users.id }),
    },
    accounts: {
      user: r.one.users({ from: r.accounts.userId, to: r.users.id }),
    },
    agentSessions: {
      user: r.one.users({ from: r.agentSessions.userId, to: r.users.id }),
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
