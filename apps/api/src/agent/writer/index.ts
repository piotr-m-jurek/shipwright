/**
 * Writer agent — public boundary.
 *
 * Input:  GapReport + answers + summaries (from Challenger + user)
 * Output: Project Brief + Implementation PRD (stored in DB + S3)
 *
 * Callers must import only from this file, never from internal modules.
 */
export { runBriefWriter } from "./brief";
export { runPrdWriter } from "./prd";
export { runRevisionBriefWriter, runRevisionPrdWriter } from "./revision";
