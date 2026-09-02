import { Schema } from "effect";

// SHIP-147: GapReport is a domain value object, canonically defined in
// packages/shared/src/domain/gap-report.ts so both the challenger and the
// XState machine (MachineContext.agentAnalysis) type against the same
// schema. Re-exported here under the challenger module's existing names so
// challenger.ts/question-generator.ts and downstream consumers (evals.ts,
// test-corpus.ts, run-session-workflow.ts) don't all need renaming.
export { ConflictSchema as ConflictEffectSchema, GapReportSchema as GapReportEffectSchema } from "@shipwright/shared/domain/gap-report";
export type { GapReport as GapReportEffect } from "@shipwright/shared/domain/gap-report";

export const ClarifyingQuestionEffectSchema = Schema.Struct({
  text: Schema.String,
  rationale: Schema.String,
  sourceDocuments: Schema.Array(Schema.String),
  priority: Schema.Literals(["high", "medium", "low"]),
});

export const ClarifyingQuestionsEffectSchema = Schema.Struct({
  questions: Schema.Array(ClarifyingQuestionEffectSchema).check(
    Schema.isMinLength(3),
    Schema.isMaxLength(7),
  ),
  stopReason: Schema.optionalKey(Schema.Literals(["sufficient_gaps", "round_limit"])),
});

export type ClarifyingQuestionsEffect = typeof ClarifyingQuestionsEffectSchema.Type;
