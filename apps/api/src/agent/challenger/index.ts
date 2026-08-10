/**
 * Challenger agent — public boundary.
 *
 * Input:  DocumentSummary[] (from Extractor)
 * Output: GapReport + ClarifyingQuestions[]
 *
 * Callers must import only from this file, never from internal modules.
 */
export { runChallenger } from "./challenger";
export { runQuestionGenerator } from "./question-generator";
export type { GapReportEffect, ClarifyingQuestionsEffect } from "./schemas";
export { GapReportEffectSchema, ClarifyingQuestionsEffectSchema } from "./schemas";
