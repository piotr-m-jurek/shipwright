/**
 * Extractor agent — public boundary.
 *
 * Input:  sessionId (documents fetched from DB internally)
 * Output: DocumentSummary[] persisted to DB; per-document summarizeDocument
 *         callable for concurrent fiber-per-doc pattern.
 *
 * Callers must import only from this file, never from internal modules.
 */
export { summarizeDocument, summarizeAllDocuments, persistSummary } from "./summarizer";
export type { DocumentSummaryEffect } from "./schemas";
export { DocumentSummaryEffectSchema, ItemWithSourceEffectSchema } from "./schemas";
