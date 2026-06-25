import { eq, and, desc, asc, inArray } from "drizzle-orm";
import type {
  InsertAgentSession,
  InsertChunk,
  InsertDocument,
  SelectAgentSession,
  SelectChunk,
  SelectDocument,
} from "../shared/schemas/index.js";
type ItemWithSource = { text: string; sourceDocument: string; confidence: "high" | "medium" | "low" };
type DocumentSummary = { sourceDocument: string; summary: string; requirements: readonly ItemWithSource[]; constraints: readonly ItemWithSource[]; assumptions: readonly ItemWithSource[] };
import { AppDBLayer, DB } from "./index.js";
import {
  agentSessions,
  chunks,
  documents,
  documentSummaries,
  summaryItems,
  questions,
  answers,
  outputs,
  DocumentSummaryInsert,
  DocumentSummarySelect,
  SummaryItemInsert,
  SummaryItemSelect,
} from "./schema.js";
import { Context, Effect, Layer, pipe, Schema } from "effect";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";

export type OutputInsert = typeof outputs.$inferInsert;
export type OutputSelect = typeof outputs.$inferSelect;

export type QuestionInsert = typeof questions.$inferInsert;
export type QuestionSelect = typeof questions.$inferSelect;
export type AnswerInsert = typeof answers.$inferInsert;
export type AnswerSelect = typeof answers.$inferSelect;

// Reconstructed summary — summary row joined with its items, shaped as DocumentSummary
export type ReconstructedSummary = DocumentSummary & {
  id: string;
  documentId: string;
  sessionId: string;
  tokenCount: number;
  version: number;
};

export class DocumentNotFoundError extends Error {}

export class AgentSessionNotFoundError extends Schema.TaggedErrorClass<AgentSessionNotFoundError>()(
  "AgentSessionNotFoundError",
  {},
) {}

const makeDatabaseService = Effect.gen(function* () {
  const db = yield* DB;
  const createAgentSession = Effect.fnUntraced(function* (data: InsertAgentSession) {
    const [result] = yield* db
      .insert(agentSessions)
      .values(data as any)
      .returning();

    return result;
  });

  const updateAgentSession = Effect.fnUntraced(function* (
    sessionId: string,
    status: SelectAgentSession["status"],
  ) {
    const [result] = yield* db
      .update(agentSessions)
      .set({ status })
      .where(eq(agentSessions.id, sessionId))
      .returning();

    return result;
  });

  const updateAgentSessionSnapshot = Effect.fnUntraced(function* (
    sessionId: string,
    status: SelectAgentSession["status"],
    xstateSnapshot: unknown,
  ) {
    yield* db
      .update(agentSessions)
      .set({ status, xstateSnapshot: xstateSnapshot as any })
      .where(eq(agentSessions.id, sessionId));
  });

  const getAgentSesionById = Effect.fnUntraced(function* (agentSessionId: string) {
    const [result] = yield* db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, agentSessionId));

    return result;
  });

  const createDocument = Effect.fnUntraced(function* (data: InsertDocument) {
    const [result] = yield* db.insert(documents).values(data).returning();
    return result;
  });

  const getDocumentById = Effect.fnUntraced(function* (id: string) {
    const results = yield* db.select().from(documents).where(eq(documents.id, id)).limit(1);
    if (results.length !== 1) {
      return yield* Effect.fail(new DocumentNotFoundError());
    }
    return results[0];
  });

  const getDocumentsBySessionId = Effect.fnUntraced(function* (sessionId: string) {
    return yield* db.select().from(documents).where(eq(documents.sessionId, sessionId));
  });

  const updateDocument = Effect.fnUntraced(function* (
    documentId: string,
    payload: Pick<SelectDocument, "status" | "tokenCount">,
  ) {
    yield* db.update(documents).set(payload).where(eq(documents.id, documentId));
  });

  const updateDocumentStatus = Effect.fnUntraced(function* (
    documentId: string,
    status: SelectDocument["status"],
  ) {
    yield* db.update(documents).set({ status }).where(eq(documents.id, documentId));
  });

  const updateDocumentTokenCount = Effect.fnUntraced(function* (
    documentId: string,
    tokenCount: number,
  ) {
    yield* db.update(documents).set({ tokenCount }).where(eq(documents.id, documentId));
  });

  const createChunks = Effect.fnUntraced(function* (data: InsertChunk[]) {
    return yield* db.insert(chunks).values(data).returning();
  });

  const getChunksByDocumentId = Effect.fnUntraced(function* (documentId: string) {
    return yield* db
      .select()
      .from(chunks)
      .where(eq(chunks.documentId, documentId))
      .orderBy(asc(chunks.chunkIndex));
  });

  const createDocumentSummary = Effect.fnUntraced(function* (data: DocumentSummaryInsert) {
    const [result] = yield* db.insert(documentSummaries).values(data).returning();
    return result;
  });

  const createSummaryItems = Effect.fnUntraced(function* (data: SummaryItemInsert[]) {
    if (data.length === 0) return [] as SummaryItemSelect[];
    return yield* db.insert(summaryItems).values(data).returning();
  });

  const getCurrentDocumenSummaryVersion = Effect.fnUntraced(function* ({
    documentId,
    sessionId,
  }: {
    documentId: string;
    sessionId: string;
  }) {
    const results = yield* db
      .select({ version: documentSummaries.version })
      .from(documentSummaries)
      .where(
        and(
          eq(documentSummaries.documentId, documentId),
          eq(documentSummaries.sessionId, sessionId),
        ),
      )
      .orderBy(desc(documentSummaries.version))
      .limit(1);

    if (results.length === 0) return 0;
    return results[0].version;
  });

  const getFinalSummariesBySession = Effect.fnUntraced(function* (sessionId: string) {
    const summaryRows = yield* db
      .selectDistinctOn([documentSummaries.documentId], {
        id: documentSummaries.id,
        documentId: documentSummaries.documentId,
        sessionId: documentSummaries.sessionId,
        sourceDocument: documentSummaries.sourceDocument,
        summary: documentSummaries.content,
        tokenCount: documentSummaries.tokenCount,
        version: documentSummaries.version,
      })
      .from(documentSummaries)
      .where(
        and(
          eq(documentSummaries.sessionId, sessionId),
          eq(documentSummaries.summaryType, "final"),
        ),
      )
      .orderBy(asc(documentSummaries.documentId), desc(documentSummaries.version));

    if (summaryRows.length === 0) return [] as ReconstructedSummary[];

    const summaryIds = summaryRows.map((r) => r.id);

    const itemRows = yield* db
      .select()
      .from(summaryItems)
      .where(
        summaryIds.length === 1
          ? eq(summaryItems.summaryId, summaryIds[0]!)
          : inArray(summaryItems.summaryId, summaryIds),
      )
      .orderBy(asc(summaryItems.summaryId), asc(summaryItems.orderIndex));

    return reconstructSummaries(summaryRows, itemRows);
  });

  const createQuestions = Effect.fnUntraced(function* (data: QuestionInsert[]) {
    if (data.length === 0) return [] as QuestionSelect[];
    return yield* db.insert(questions).values(data).returning();
  });

  const getQuestionsBySessionId = Effect.fnUntraced(function* (sessionId: string) {
    return yield* db
      .select()
      .from(questions)
      .where(eq(questions.sessionId, sessionId))
      .orderBy(asc(questions.orderIndex));
  });

  const createAnswers = Effect.fnUntraced(function* (data: AnswerInsert[]) {
    if (data.length === 0) return [] as AnswerSelect[];
    return yield* db.insert(answers).values(data).returning();
  });

  const getAnswersBySessionId = Effect.fnUntraced(function* (sessionId: string) {
    return yield* db.select().from(answers).where(eq(answers.sessionId, sessionId));
  });

  const deleteAgentSession = Effect.fnUntraced(function* (sessionId: string) {
    yield* db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
  });

  const getChunksBySessionId = Effect.fnUntraced(function* (sessionId: string) {
    return yield* db.select().from(chunks).where(eq(chunks.sessionId, sessionId));
  });

  const createOutput = Effect.fnUntraced(function* (data: OutputInsert) {
    const [result] = yield* db.insert(outputs).values(data).returning();
    return result;
  });

  const getOutputsBySessionId = Effect.fnUntraced(function* (sessionId: string) {
    return yield* db
      .select()
      .from(outputs)
      .where(eq(outputs.sessionId, sessionId))
      .orderBy(desc(outputs.version));
  });

  const getLatestOutputByType = Effect.fnUntraced(function* (
    sessionId: string,
    type: OutputSelect["type"],
  ) {
    const [result] = yield* db
      .select()
      .from(outputs)
      .where(and(eq(outputs.sessionId, sessionId), eq(outputs.type, type)))
      .orderBy(desc(outputs.version))
      .limit(1);
    return result as OutputSelect | undefined;
  });

  return {
    createAgentSession,
    updateAgentSession,
    updateAgentSessionSnapshot,
    getAgentSesionById,
    createDocument,
    getDocumentById,
    getDocumentsBySessionId,
    updateDocument,
    updateDocumentStatus,
    updateDocumentTokenCount,
    createChunks,
    getChunksByDocumentId,
    createDocumentSummary,
    createSummaryItems,
    getCurrentDocumenSummaryVersion,
    getFinalSummariesBySession,
    createQuestions,
    getQuestionsBySessionId,
    createAnswers,
    getAnswersBySessionId,
    deleteAgentSession,
    getChunksBySessionId,
    createOutput,
    getOutputsBySessionId,
    getLatestOutputByType,
  };
});

function reconstructSummaries(
  summaryRows: {
    id: string;
    documentId: string;
    sessionId: string;
    sourceDocument: string;
    summary: string;
    tokenCount: number;
    version: number;
  }[],
  itemRows: SummaryItemSelect[],
): ReconstructedSummary[] {
  const itemsBySummaryId = new Map<string, SummaryItemSelect[]>();
  for (const item of itemRows) {
    const list = itemsBySummaryId.get(item.summaryId);
    if (list) {
      list.push(item);
    } else {
      itemsBySummaryId.set(item.summaryId, [item]);
    }
  }

  return summaryRows.map((row) => {
    const items = itemsBySummaryId.get(row.id) ?? [];
    return {
      id: row.id,
      documentId: row.documentId,
      sessionId: row.sessionId,
      sourceDocument: row.sourceDocument,
      summary: row.summary,
      tokenCount: row.tokenCount,
      version: row.version,
      requirements: items
        .filter((i) => i.itemType === "requirement")
        .map((i) => ({ text: i.text, sourceDocument: i.sourceDocument, confidence: i.confidence })),
      constraints: items
        .filter((i) => i.itemType === "constraint")
        .map((i) => ({ text: i.text, sourceDocument: i.sourceDocument, confidence: i.confidence })),
      assumptions: items
        .filter((i) => i.itemType === "assumption")
        .map((i) => ({ text: i.text, sourceDocument: i.sourceDocument, confidence: i.confidence })),
    };
  });
}

export class DatabaseService extends Context.Service<
  DatabaseService,
  {
    createAgentSession: (
      data: InsertAgentSession,
    ) => Effect.Effect<SelectAgentSession, AgentSessionNotFoundError | EffectDrizzleQueryError>;
    updateAgentSession: (
      sessionId: string,
      status: SelectAgentSession["status"],
    ) => Effect.Effect<SelectAgentSession, EffectDrizzleQueryError>;
    updateAgentSessionSnapshot: (
      sessionId: string,
      status: SelectAgentSession["status"],
      xstateSnapshot: unknown,
    ) => Effect.Effect<void, EffectDrizzleQueryError>;
    getAgentSesionById: (
      agentSessionId: string,
    ) => Effect.Effect<SelectAgentSession | undefined, EffectDrizzleQueryError>;

    createDocument: (
      data: InsertDocument,
    ) => Effect.Effect<SelectDocument, EffectDrizzleQueryError>;
    getDocumentById: (
      id: string,
    ) => Effect.Effect<SelectDocument, DocumentNotFoundError | EffectDrizzleQueryError>;
    getDocumentsBySessionId: (
      sessionId: string,
    ) => Effect.Effect<SelectDocument[], EffectDrizzleQueryError>;
    updateDocument: (
      documentId: string,
      payload: Pick<SelectDocument, "status" | "tokenCount">,
    ) => Effect.Effect<void, EffectDrizzleQueryError>;
    updateDocumentStatus: (
      documentId: string,
      status: SelectDocument["status"],
    ) => Effect.Effect<void, EffectDrizzleQueryError>;
    updateDocumentTokenCount: (
      documentId: string,
      tokenCount: number,
    ) => Effect.Effect<void, EffectDrizzleQueryError>;

    createChunks: (data: InsertChunk[]) => Effect.Effect<SelectChunk[], EffectDrizzleQueryError>;
    getChunksByDocumentId: (
      documentId: string,
    ) => Effect.Effect<SelectChunk[], EffectDrizzleQueryError>;

    createDocumentSummary: (
      data: DocumentSummaryInsert,
    ) => Effect.Effect<DocumentSummarySelect, EffectDrizzleQueryError>;
    createSummaryItems: (
      data: SummaryItemInsert[],
    ) => Effect.Effect<SummaryItemSelect[], EffectDrizzleQueryError>;
    getCurrentDocumenSummaryVersion: (args: {
      documentId: string;
      sessionId: string;
    }) => Effect.Effect<number, EffectDrizzleQueryError>;
    getFinalSummariesBySession: (
      sessionId: string,
    ) => Effect.Effect<ReconstructedSummary[], EffectDrizzleQueryError>;

    createQuestions: (
      data: QuestionInsert[],
    ) => Effect.Effect<QuestionSelect[], EffectDrizzleQueryError>;
    getQuestionsBySessionId: (
      sessionId: string,
    ) => Effect.Effect<QuestionSelect[], EffectDrizzleQueryError>;

    createAnswers: (
      data: AnswerInsert[],
    ) => Effect.Effect<AnswerSelect[], EffectDrizzleQueryError>;
    getAnswersBySessionId: (
      sessionId: string,
    ) => Effect.Effect<AnswerSelect[], EffectDrizzleQueryError>;

    deleteAgentSession: (sessionId: string) => Effect.Effect<void, EffectDrizzleQueryError>;
    getChunksBySessionId: (
      sessionId: string,
    ) => Effect.Effect<SelectChunk[], EffectDrizzleQueryError>;

    createOutput: (data: OutputInsert) => Effect.Effect<OutputSelect, EffectDrizzleQueryError>;
    getOutputsBySessionId: (
      sessionId: string,
    ) => Effect.Effect<OutputSelect[], EffectDrizzleQueryError>;
    getLatestOutputByType: (
      sessionId: string,
      type: OutputSelect["type"],
    ) => Effect.Effect<OutputSelect | undefined, EffectDrizzleQueryError>;
  }
>()("shipwright/db/queries/DatabaseService") {
  static readonly layer = pipe(
    Layer.effect(DatabaseService, makeDatabaseService),
    Layer.provide(AppDBLayer),
  );
}
