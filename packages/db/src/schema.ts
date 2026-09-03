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

import { type MachineContext } from "@shipwright/shared/schemas/machine";
import type {
  AgentSessionId,
  AnswerId,
  ChunkId,
  DocumentId,
  McpTokenId,
  OutputId,
  QuestionId,
  SummaryId,
  SummaryItemId,
} from "@shipwright/shared/domain/ids";
import {
  CONFIDENCE_LEVEL_VALUES,
  DOCUMENT_STATUS_VALUES,
  INPUT_MODE_VALUES,
  OUTPUT_TYPE_VALUES,
  SESSION_STATUS_VALUES,
  SUMMARY_ITEM_TYPE_VALUES,
  SUMMARY_TYPE_VALUES,
} from "@shipwright/shared/domain/types";
import type { ChunkIndex, OutputVersion, TokenCount } from "@shipwright/shared/domain/value-objects";

// NOTE: pgEnum requires a non-empty tuple [string, ...string[]]. The *_VALUES
// arrays imported from @shipwright/shared/domain/types are `as const` readonly
// tuples — Drizzle accepts these. If you ever add a new enum, ensure the array
// has at least one element; an empty array will fail at runtime, not compile time.

// ── Better Auth tables ────────────────────────────────────────────────────
// This is the single owner of the full relational schema for this database.
// Auth tables live here (not in @shipwright/auth) because agentSessions.userId
// is a live foreign key into `users` — tables joined by a literal .references()
// call must be defined in the same schema-owning package as everything else
// they're related to via defineRelations(). Splitting FK-coupled tables across
// packages requires the exact same physical object identity for the reference
// to resolve correctly, which is fragile (see the drizzle-orm peer-dependency
// instance-fragmentation issue this project already hit once).
//
// @shipwright/auth imports these table definitions FROM here to build its
// drizzleAdapter — the dependency points auth -> db, never the reverse.
//
// effect-mq's job-store tables (SHIP-109) are NOT part of this schema: they
// have zero .references() into this relational graph (job payloads carry
// sessionId as opaque JSON, not a SQL FK), so they stay independently owned
// and migrated in packages/queue/src/schema.ts — drizzle.config.ts's
// `schema` array lists both files. That is the correct exception to this
// rule — tables with no foreign-key coupling to the shared graph don't need
// to share an owner.

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

export const sessionStatusEnum = pgEnum("session_status", SESSION_STATUS_VALUES);

export const inputModeEnum = pgEnum("input_mode", INPUT_MODE_VALUES);

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
  errorReason: text("error_reason"),
});

export const documentStatusEnum = pgEnum("document_status", DOCUMENT_STATUS_VALUES);

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
  tokenCount: integer("token_count").$type<TokenCount>(),
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
  chunkIndex: integer("chunk_index").notNull().$type<ChunkIndex>(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  headingPath: text("heading_path").array(),
  pageNumber: integer("page_number"),
});

export const summaryTypeEnum = pgEnum("summary_type", SUMMARY_TYPE_VALUES);

export const confidenceLevelEnum = pgEnum("confidence_level", CONFIDENCE_LEVEL_VALUES);

export const summaryItemTypeEnum = pgEnum("summary_item_type", SUMMARY_ITEM_TYPE_VALUES);

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
  tokenCount: integer("token_count").notNull().$type<TokenCount>(),
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

export const outputTypeEnum = pgEnum("output_type", OUTPUT_TYPE_VALUES);

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
  version: integer().$type<OutputVersion>(),
  // S3 key for presigned GET URL export — set when output is uploaded to storage
  s3Key: text("s3_key"),
});

// One active MCP token per user (SHIP-115 Step 6) — not the better-auth
// session_token. session_token is HttpOnly and shared across every apps/api
// endpoint the browser can reach; this is a separate, purpose-scoped
// credential so a leak only grants MCP access, and it's independently
// revocable without touching the browser session. `userId` is `.unique()`
// (not the primary key) so "generate" can upsert on conflict, replacing any
// existing token for that user rather than accumulating rows.
export const mcpTokens = pgTable("mcp_tokens", {
  id: uuid("id").primaryKey().defaultRandom().notNull().$type<McpTokenId>(),
  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  // Never store the raw token — only its SHA-256 hash, same practice as
  // password/API-key storage. The raw value is shown to the user exactly
  // once, at generation time, and is not recoverable after that.
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Not written to in v1 (see Stack doc / SHIP-115) — reserved for a future
  // "last used" UI affordance without a schema change.
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
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
    questions,
    answers,
    outputs,
    mcpTokens,
  },
  (r) => ({
    users: {
      agentSessions: r.many.agentSessions(),
      sessions: r.many.sessions(),
      accounts: r.many.accounts(),
      mcpToken: r.one.mcpTokens(),
    },
    mcpTokens: {
      user: r.one.users({ from: r.mcpTokens.userId, to: r.users.id }),
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
