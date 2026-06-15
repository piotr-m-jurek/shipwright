import { eq, and, desc, asc } from "drizzle-orm";
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
  DocumentSummaryInsert,
  DocumentSummarySelect,
  SummaryItemInsert,
  SummaryItemSelect,
} from "./schema.js";

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
  const [result] = await db.insert(agentSessions).values(data).returning();

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
  // Select the latest final summary per document, joined with all its items.
  // DISTINCT ON picks the highest version per documentId (ordered desc by version).
  // summaryItems.orderIndex preserves the original array order of items.
  const rows = await db
    .selectDistinctOn([documentSummaries.documentId], {
      // summary columns
      summaryId: documentSummaries.id,
      documentId: documentSummaries.documentId,
      sessionId: documentSummaries.sessionId,
      sourceDocument: documentSummaries.sourceDocument,
      summary: documentSummaries.content,
      tokenCount: documentSummaries.tokenCount,
      version: documentSummaries.version,
      // item columns
      itemId: summaryItems.id,
      itemType: summaryItems.itemType,
      itemText: summaryItems.text,
      itemSourceDocument: summaryItems.sourceDocument,
      itemConfidence: summaryItems.confidence,
      itemOrderIndex: summaryItems.orderIndex,
    })
    .from(documentSummaries)
    .leftJoin(summaryItems, eq(summaryItems.summaryId, documentSummaries.id))
    .where(
      and(eq(documentSummaries.sessionId, sessionId), eq(documentSummaries.summaryType, "final")),
    )
    .orderBy(
      asc(documentSummaries.documentId),
      desc(documentSummaries.version),
      asc(summaryItems.orderIndex),
    );

  return reconstructSummaries(rows);
}

type SummaryRow = {
  summaryId: string;
  documentId: string;
  sessionId: string;
  sourceDocument: string;
  summary: string;
  tokenCount: number;
  version: number;
  itemId: string | null;
  itemType: SummaryItemSelect["itemType"] | null;
  itemText: string | null;
  itemSourceDocument: string | null;
  itemConfidence: SummaryItemSelect["confidence"] | null;
  itemOrderIndex: number | null;
};

function reconstructSummaries(rows: SummaryRow[]): ReconstructedSummary[] {
  const map = new Map<string, ReconstructedSummary>();

  for (const row of rows) {
    if (map.has(row.summaryId)) {
      continue;
    }
    map.set(row.summaryId, {
      id: row.summaryId,
      documentId: row.documentId,
      sessionId: row.sessionId,
      sourceDocument: row.sourceDocument,
      summary: row.summary,
      tokenCount: row.tokenCount,
      version: row.version,
      requirements: [],
      constraints: [],
      assumptions: [],
    });

    // left join produces null item columns when a summary has no items
    if (
      row.itemId &&
      row.itemType &&
      row.itemText &&
      row.itemSourceDocument &&
      row.itemConfidence
    ) {
      const entry = map.get(row.summaryId)!;
      const item = {
        text: row.itemText,
        sourceDocument: row.itemSourceDocument,
        confidence: row.itemConfidence,
      };
      if (row.itemType === "requirement") entry.requirements.push(item);
      else if (row.itemType === "constraint") entry.constraints.push(item);
      else if (row.itemType === "assumption") entry.assumptions.push(item);
    }
  }

  return Array.from(map.values());
}
