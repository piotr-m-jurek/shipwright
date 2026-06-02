import { pgEnum, pgTable, uuid, timestamp, text, jsonb, integer, vector, foreignKey, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const documentType = pgEnum("document_type", ["transcript", "prd_draft", "rfp", "notes"])
export const inputMode = pgEnum("input_mode", ["context", "retrieval"])
export const role = pgEnum("role", ["user", "assistant", "system"])
export const outputType = pgEnum("output_type", ["project_brief", "implementation_prd"])
export const sessionStatus = pgEnum("session_status", ["idle", "uploading", "processing", "analyzing", "awaiting_answers", "re_evaluating", "generating", "complete", "error"])


export const answers = pgTable("answers", {
	id: uuid().defaultRandom().primaryKey(),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
	sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" } ),
	questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" } ),
	text: text().notNull(),
	round: integer().notNull(),
});

export const chunks = pgTable("chunks", {
	id: uuid().defaultRandom().primaryKey(),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
	documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" } ),
	sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" } ),
	content: text().notNull(),
	chunkIndex: integer("chunk_index").notNull(),
	embedding: vector({ dimensions: 1536 }).notNull(),
	documentType: documentType("document_type").notNull(),
});

export const documents = pgTable("documents", {
	id: uuid().defaultRandom().primaryKey(),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
	sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" } ),
	filename: text().notNull(),
	documentType: documentType("document_type").notNull(),
	storagePath: text("storage_path"),
	rawText: text("raw_text"),
	tokenCount: integer("token_count"),
});

export const messages = pgTable("messages", {
	id: uuid().defaultRandom().primaryKey(),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
	sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" } ),
	content: text().notNull(),
	role: role().notNull(),
	agentPass: text("agent_pass"),
});

export const outputs = pgTable("outputs", {
	id: uuid().defaultRandom().primaryKey(),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
	sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" } ),
	type: outputType().notNull(),
	content: text(),
	version: integer(),
});

export const questions = pgTable("questions", {
	id: uuid().defaultRandom().primaryKey(),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
	sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" } ),
	text: text().notNull(),
	sourceDocuments: text("source_documents").array().notNull(),
	rationale: text().notNull(),
	orderIndex: integer("order_index").notNull(),
});

export const sessions = pgTable("sessions", {
	id: uuid().defaultRandom().primaryKey(),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
	status: sessionStatus().default("idle").notNull(),
	inputMode: inputMode("input_mode").default("context").notNull(),
	xstateSnapshot: jsonb("xstate_snapshot"),
});
