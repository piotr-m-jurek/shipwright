/**
 * Pure row → domain-type mappers. Repositories call these before returning,
 * so nothing outside `packages/db` ever sees a raw Drizzle Select* row.
 *
 * Most fields already carry the right type at the SELECT level (columns are
 * declared with `.$type<Branded>()` in schema.ts), so most of these are
 * near-identity — the mapper still exists explicitly so a schema change that
 * breaks the shape fails at the mapper's own definition, not wherever an
 * `as` cast happened to be used.
 */
import type {
  AgentSession,
  Answer,
  Chunk,
  Document,
  Output,
  Question,
} from "@shipwright/shared/domain/types";
import type {
  AnswerSelect,
  OutputSelect,
  QuestionSelect,
  SelectAgentSession,
  SelectChunk,
  SelectDocument,
} from "./types";
import type { MachineContext } from "@shipwright/shared/schemas/machine";

export const toAgentSession = (row: SelectAgentSession): AgentSession => ({
  id: row.id,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  userId: row.userId,
  status: row.status,
  inputMode: row.inputMode,
  errorReason: row.errorReason,
});

/**
 * AgentSession plus the internal XState snapshot — not part of the domain
 * model (deliberately excluded from `AgentSession`), but genuinely needed by
 * actor restoration (session-actor.ts) and the debug endpoints. A narrow,
 * purpose-built type for those specific consumers rather than widening the
 * general-purpose AgentSession domain type for everyone.
 */
export interface AgentSessionSnapshot extends AgentSession {
  readonly xstateSnapshot: MachineContext | null;
}

export const toAgentSessionSnapshot = (row: SelectAgentSession): AgentSessionSnapshot => ({
  ...toAgentSession(row),
  xstateSnapshot: row.xstateSnapshot,
});

export const toDocument = (row: SelectDocument): Document => ({
  id: row.id,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  sessionId: row.sessionId,
  filename: row.filename,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  rawText: row.rawText,
  status: row.status,
  storagePath: row.storagePath,
  tokenCount: row.tokenCount,
});

export const toChunk = (row: SelectChunk): Chunk => ({
  id: row.id,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  sessionId: row.sessionId,
  documentId: row.documentId,
  charOffset: row.charOffset,
  chunkIndex: row.chunkIndex,
  content: row.content,
  embedding: row.embedding,
  headingPath: row.headingPath,
  pageNumber: row.pageNumber,
});

export const toQuestion = (row: QuestionSelect): Question => ({
  id: row.id,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  sessionId: row.sessionId,
  text: row.text,
  sourceDocuments: row.sourceDocuments,
  rationale: row.rationale,
  orderIndex: row.orderIndex,
});

export const toAnswer = (row: AnswerSelect): Answer => ({
  id: row.id,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  sessionId: row.sessionId,
  questionId: row.questionId,
  text: row.text,
  round: row.round,
});

export const toOutput = (row: OutputSelect): Output => ({
  id: row.id,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  sessionId: row.sessionId,
  type: row.type,
  content: row.content,
  version: row.version,
  s3Key: row.s3Key,
});
