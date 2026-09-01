/**
 * Shared identifiers between register-corpus-dataset.ts (SHIP-153, writes the
 * dataset) and evals.ts (SHIP-168, writes dataset run results against it) —
 * a single source of truth so the two scripts can't drift on which Langfuse
 * dataset/item a run result gets linked to.
 */
export const DATASET_NAME = "shipwright-eval-corpus";
export const CORPUS_CASE_ID = "leave-management-v1";
