import { Schema } from "effect";

export const ConflictEffectSchema = Schema.Struct({
  description: Schema.String,
  documentA: Schema.String, // filename of first source
  documentB: Schema.String, // filename of second source
});

export const GapReportEffectSchema = Schema.Struct({
  conflicts: Schema.Array(ConflictEffectSchema),
  gaps: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      affectedArea: Schema.String,
    }),
  ),
  ambiguities: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      sourceDocument: Schema.String,
    }),
  ),
});

export type GapReportEffect = typeof GapReportEffectSchema.Type;

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
