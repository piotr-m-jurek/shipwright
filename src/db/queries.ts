import { eq, and, desc, asc, inArray } from "drizzle-orm";
import type {
  InsertAgentSession,
  InsertChunk,
  InsertDocument,
  SelectAgentSession,
  SelectChunk,
  SelectDocument,
} from "../shared/schemas/index.js";
import { DocumentSummary } from "../shared/schemas/agent.js";
import { db } from "./index.js";
import {
  agentSessions,
  chunks,
  documents,
  documentSummaries,
  summaryItems,
  questions,
  answers,
  DocumentSummaryInsert,
  DocumentSummarySelect,
  SummaryItemInsert,
  SummaryItemSelect,
} from "./schema.js";

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

export async function createAgentSession(data: InsertAgentSession): Promise<SelectAgentSession> {
  const [result] = await db
    .insert(agentSessions)
    .values(data as any)
    .returning();

  // TODO: figure out the typing: json seems to be returned as unknown instead of Json type
  return result as unknown as SelectAgentSession;
}

export async function updateAgentSession(
  sessionId: string,
  status: SelectAgentSession["status"],
): Promise<SelectAgentSession> {
  const [result] = await db
    .update(agentSessions)
    .set({ status })
    .where(eq(agentSessions.id, sessionId))
    .returning();

  return result as SelectAgentSession;
}

export async function updateAgentSessionSnapshot(
  sessionId: string,
  status: SelectAgentSession["status"],
  xstateSnapshot: unknown,
): Promise<void> {
  await db
    .update(agentSessions)
    .set({ status, xstateSnapshot: xstateSnapshot as any })
    .where(eq(agentSessions.id, sessionId));
}

export async function getAgentSesionById(agentSessionId: string) {
  const [result] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, agentSessionId));

  return result;
}

export async function createDocument(data: InsertDocument): Promise<SelectDocument> {
  const [result] = await db.insert(documents).values(data).returning();
  return result;
}

/**
 * @throws DocumentNotFoundError
 */
export async function getDocumentById(id: string): Promise<SelectDocument> {
  const results = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (results.length !== 1) {
    throw new DocumentNotFoundError();
  }

  return results[0];
}

export async function getDocumentsBySessionId(sessionId: string) {
  return db.select().from(documents).where(eq(documents.sessionId, sessionId));
}

export async function updateDocument(
  documentId: string,
  payload: Pick<SelectDocument, "status" | "tokenCount">,
) {
  await db.update(documents).set(payload).where(eq(documents.id, documentId));
}

export async function updateDocumentStatus(documentId: string, status: SelectDocument["status"]) {
  await db.update(documents).set({ status }).where(eq(documents.id, documentId));
}

export async function updateDocumentTokenCount(
  documentId: string,
  tokenCount: number,
): Promise<void> {
  await db.update(documents).set({ tokenCount }).where(eq(documents.id, documentId));
}

export async function createChunks(data: InsertChunk[]): Promise<SelectChunk[]> {
  const results = await db.insert(chunks).values(data).returning();
  return results;
}

export async function getChunksByDocumentId(documentId: string): Promise<SelectChunk[]> {
  const results = await db
    .select()
    .from(chunks)
    .where(eq(chunks.documentId, documentId))
    .orderBy(asc(chunks.chunkIndex));

  return results;
}

export async function createDocumentSummary(
  data: DocumentSummaryInsert,
): Promise<DocumentSummarySelect> {
  const [result] = await db.insert(documentSummaries).values(data).returning();
  return result;
}

export async function createSummaryItems(data: SummaryItemInsert[]): Promise<SummaryItemSelect[]> {
  if (data.length === 0) return [];
  return db.insert(summaryItems).values(data).returning();
}

export async function getCurrentDocumenSummaryVersion({
  documentId,
  sessionId,
}: {
  documentId: string;
  sessionId: string;
}) {
  const results = await db
    .select({ version: documentSummaries.version })
    .from(documentSummaries)
    .where(
      and(eq(documentSummaries.documentId, documentId), eq(documentSummaries.sessionId, sessionId)),
    )
    .orderBy(desc(documentSummaries.version))
    .limit(1);

  if (results.length === 0) {
    return 0;
  }
  return results[0].version;
}

export async function getFinalSummariesBySession(
  sessionId: string,
): Promise<ReconstructedSummary[]> {
  // Two separate queries to avoid the DISTINCT ON + leftJoin collapse bug.
  // DISTINCT ON with a JOIN collapses to one row per documentId, so item arrays
  // would only ever have 0-1 entries. Instead: query summaries, then items separately.

  // 1. Latest final summary per document for this session.
  const summaryRows = await db
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
      and(eq(documentSummaries.sessionId, sessionId), eq(documentSummaries.summaryType, "final")),
    )
    .orderBy(asc(documentSummaries.documentId), desc(documentSummaries.version));

  if (summaryRows.length === 0) return [];

  const summaryIds = summaryRows.map((r) => r.id);

  // 2. All items belonging to those summaries, ordered for correct reconstruction.
  const itemRows = await db
    .select()
    .from(summaryItems)
    .where(
      summaryIds.length === 1
        ? eq(summaryItems.summaryId, summaryIds[0]!)
        : inArray(summaryItems.summaryId, summaryIds),
    )
    .orderBy(asc(summaryItems.summaryId), asc(summaryItems.orderIndex));

  return reconstructSummaries(summaryRows, itemRows);
}

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
  // Index items by summaryId for O(1) lookup.
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

// ── Questions ──────────────────────────────────────────────────────────────

export async function createQuestions(data: QuestionInsert[]): Promise<QuestionSelect[]> {
  if (data.length === 0) {
    return [];
  }
  return db.insert(questions).values(data).returning();
}

export async function getQuestionsBySessionId(sessionId: string): Promise<QuestionSelect[]> {
  return db
    .select()
    .from(questions)
    .where(eq(questions.sessionId, sessionId))
    .orderBy(asc(questions.orderIndex));
}

// ── Answers ────────────────────────────────────────────────────────────────

export async function createAnswers(data: AnswerInsert[]): Promise<AnswerSelect[]> {
  if (data.length === 0) {
    return [];
  }
  return db.insert(answers).values(data).returning();
}

export async function getAnswersBySessionId(sessionId: string): Promise<AnswerSelect[]> {
  return db.select().from(answers).where(eq(answers.sessionId, sessionId));
}
