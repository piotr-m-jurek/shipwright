import { Schema } from "effect";

/**
 * GapReport — value object (SHIP-147).
 *
 * No identity: two reports with identical fields are interchangeable.
 * Produced once by the Challenger pass, consumed read-only by the Question
 * Generator and Writer passes. Never mutated after construction — if the
 * Challenger re-runs (e.g. after a revision), a new GapReport replaces the
 * old one entirely in MachineContext.agentAnalysis, it isn't patched.
 *
 * All fields are readonly on the inferred `.Type` (Schema.Struct fields are
 * readonly by default in this Effect version) — enforced by the compiler,
 * not just this comment.
 */
export const ConflictSchema = Schema.Struct({
  description: Schema.String,
  documentA: Schema.String, // filename of first source
  documentB: Schema.String, // filename of second source
});
export type Conflict = typeof ConflictSchema.Type;

export const GapSchema = Schema.Struct({
  description: Schema.String,
  affectedArea: Schema.String,
});
export type Gap = typeof GapSchema.Type;

export const AmbiguitySchema = Schema.Struct({
  description: Schema.String,
  sourceDocument: Schema.String,
});
export type Ambiguity = typeof AmbiguitySchema.Type;

export const GapReportSchema = Schema.Struct({
  conflicts: Schema.Array(ConflictSchema),
  gaps: Schema.Array(GapSchema),
  ambiguities: Schema.Array(AmbiguitySchema),
});

/** The boundary constructor — validates raw Challenger LLM output against
 *  the schema, making the parsing step explicit rather than implicit in
 *  whatever effect happens to call LanguageModel.generateObject. */
export const GapReport = {
  decode: Schema.decodeUnknownEffect(GapReportSchema),
};

export type GapReport = typeof GapReportSchema.Type;
