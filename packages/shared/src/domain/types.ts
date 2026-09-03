/**
 * Canonical domain types for Shipwright.
 *
 * These are the shapes that DB services must return and that the agent/handler
 * layers must consume. Nothing above `db/services/` should import from
 * `apps/api/src/db/types.ts` (the raw Drizzle inferred types).
 *
 * Naming convention: entity name without suffix, no "Select"/"Insert"/"Row".
 *
 * Enum pattern: define the values array as `const`, derive the type from it.
 *   const FOO_VALUES = ["a", "b"] as const;
 *   type Foo = typeof FOO_VALUES[number];
 */

import type {
  AgentSessionId,
  AnswerId,
  ChunkId,
  DocumentId,
  OutputId,
  QuestionId,
  SummaryId,
} from "./ids";
import type { ChunkIndex, OutputVersion, TokenCount } from "./value-objects";

// ── Enums ─────────────────────────────────────────────────────────────────

export const SESSION_STATUS_VALUES = [
  "idle",
  "uploading",
  "waiting_for_documents",
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
] as const;
export type SessionStatus = (typeof SESSION_STATUS_VALUES)[number];

export const INPUT_MODE_VALUES = ["context", "retrieval"] as const;
export type InputMode = (typeof INPUT_MODE_VALUES)[number];

export const DOCUMENT_STATUS_VALUES = [
  "pending",
  "uploaded",
  "processing",
  "ready",
  "error",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUS_VALUES)[number];

export const SUMMARY_TYPE_VALUES = ["map_intermediate", "final"] as const;
export type SummaryType = (typeof SUMMARY_TYPE_VALUES)[number];

export const CONFIDENCE_LEVEL_VALUES = ["high", "medium", "low"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVEL_VALUES)[number];

export const SUMMARY_ITEM_TYPE_VALUES = ["requirement", "constraint", "assumption"] as const;
export type SummaryItemType = (typeof SUMMARY_ITEM_TYPE_VALUES)[number];

export const OUTPUT_TYPE_VALUES = ["project_brief", "implementation_prd"] as const;
export type OutputType = (typeof OUTPUT_TYPE_VALUES)[number];

// ── Core entities ─────────────────────────────────────────────────────────

export type AgentSession = {
  id: AgentSessionId;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  status: SessionStatus;
  inputMode: InputMode;
  errorReason: string | null;
};

export type Document = {
  id: DocumentId;
  createdAt: Date;
  updatedAt: Date;
  sessionId: AgentSessionId;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  rawText: string | null;
  status: DocumentStatus;
  storagePath: string | null;
  tokenCount: TokenCount | null;
};

export type Chunk = {
  id: ChunkId;
  createdAt: Date;
  updatedAt: Date;
  sessionId: AgentSessionId;
  documentId: DocumentId;
  charOffset: number | null;
  chunkIndex: ChunkIndex;
  content: string;
  embedding: number[];
  headingPath: string[] | null;
  pageNumber: number | null;
};

export type Question = {
  id: QuestionId;
  createdAt: Date;
  updatedAt: Date;
  sessionId: AgentSessionId;
  text: string;
  sourceDocuments: string[];
  rationale: string;
  orderIndex: number;
};

export type Answer = {
  id: AnswerId;
  createdAt: Date;
  updatedAt: Date;
  sessionId: AgentSessionId;
  questionId: QuestionId;
  text: string;
  round: number;
};

export type Output = {
  id: OutputId;
  createdAt: Date;
  updatedAt: Date;
  sessionId: AgentSessionId;
  type: OutputType;
  content: string | null;
  version: OutputVersion | null;
  s3Key: string | null;
};

// ── Assembled / rich domain types ─────────────────────────────────────────

/** A summary item as a structured domain value (not a raw DB row). */
export type SummaryItem = {
  text: string;
  sourceDocument: string;
  confidence: ConfidenceLevel;
};

/**
 * A document summary joined with its structured items.
 * This is the type returned by `DbSummary.getFinalSummariesBySession`.
 * Previously defined as `ReconstructedSummary` inside `db/services/summary.ts`.
 */
export type DocumentSummary = {
  id: SummaryId;
  documentId: DocumentId;
  sessionId: AgentSessionId;
  sourceDocument: string;
  summary: string;
  tokenCount: TokenCount;
  version: number;
  requirements: readonly SummaryItem[];
  constraints: readonly SummaryItem[];
  assumptions: readonly SummaryItem[];
};
