/**
 * Challenger agent — public boundary.
 *
 * Input:  DocumentSummary[] (from Extractor)
 * Output: GapReport + ClarifyingQuestions[]
 *
 * Callers must import only from this file, never from internal modules.
 */
export { runChallenger } from "./challenger.ts";
export { runQuestionGenerator } from "./question-generator.ts";
export type { GapReportEffect, ClarifyingQuestionsEffect } from "./schemas.ts";
export { GapReportEffectSchema, ClarifyingQuestionsEffectSchema } from "./schemas.ts";
