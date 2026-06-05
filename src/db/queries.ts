import { eq } from "drizzle-orm";
import type {
  InsertAgentSession,
  InsertChunk,
  InsertDocument,
  SelectAgentSession,
  SelectChunk,
  SelectDocument,
} from "../shared/schemas/index.js";
import { db } from "./index.js";
import { agentSessions, chunks, documents } from "./schema.js";

export class DocumentNotFoundError extends Error {}

export async function createAgentSession(data: InsertAgentSession): Promise<SelectAgentSession> {
  const [result] = await db.insert(agentSessions).values(data).returning();

  // TODO: figure out the typing: json seems to be returned as unknown instead of Json type
  return result as SelectAgentSession;
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
