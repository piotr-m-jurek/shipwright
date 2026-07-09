import { Schema } from "effect";

export const EvalResultSchema = Schema.Struct({
  score: Schema.Number,
  reasoning: Schema.String,
  pass: Schema.Boolean,
  citations: Schema.optional(Schema.Array(Schema.String)),
});

export type EvalResult = typeof EvalResultSchema.Type;

export const FaithfulnessEvalSchema = Schema.Struct({
  hallucinatedRequirements: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      reason: Schema.String,
    }),
  ),
  result: EvalResultSchema,
});

export type FaithfulnessEval = typeof FaithfulnessEvalSchema.Type;

export const CompletenessEvalSchema = Schema.Struct({
  droppedItems: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      sourceDocument: Schema.String,
    }),
  ),
  result: EvalResultSchema,
});

export type CompletenessEval = typeof CompletenessEvalSchema.Type;

export const ConflictDetectionEvalSchema = Schema.Struct({
  conflictsSurfaced: Schema.Array(Schema.String),
  plantedConflictFound: Schema.Boolean,
  result: EvalResultSchema,
});

export type ConflictDetectionEval = typeof ConflictDetectionEvalSchema.Type;
