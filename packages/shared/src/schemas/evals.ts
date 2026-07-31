import { Schema } from "effect";

export class EvalResultSchema extends Schema.Opaque<EvalResultSchema>()(
  Schema.Struct({
    score: Schema.Number,
    reasoning: Schema.String,
    pass: Schema.Boolean,
    citations: Schema.optional(Schema.Array(Schema.String)),
  }),
) {}

export class FaithfulnessEvalSchema extends Schema.Opaque<FaithfulnessEvalSchema>()(
  Schema.Struct({
    hallucinatedRequirements: Schema.Array(
      Schema.Struct({
        text: Schema.String,
        reason: Schema.String,
      }),
    ),
    result: EvalResultSchema,
  }),
) {}

export class CompletenessEvalSchema extends Schema.Opaque<CompletenessEvalSchema>()(
  Schema.Struct({
    droppedItems: Schema.Array(
      Schema.Struct({
        text: Schema.String,
        sourceDocument: Schema.String,
      }),
    ),
    result: EvalResultSchema,
  }),
) {}

export class ConflictDetectionEvalSchema extends Schema.Opaque<ConflictDetectionEvalSchema>()(
  Schema.Struct({
    conflictsSurfaced: Schema.Array(Schema.String),
    plantedConflictFound: Schema.Boolean,
    result: EvalResultSchema,
  }),
) {}
