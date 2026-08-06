import { Schema } from "effect";

export const ItemWithSourceEffectSchema = Schema.Struct({
  text: Schema.String,
  sourceDocument: Schema.String,
  confidence: Schema.Literals(["high", "medium", "low"]),
});

export const DocumentSummaryEffectSchema = Schema.Struct({
  sourceDocument: Schema.String, // filename — required, never optional
  summary: Schema.String, // prose summary of the content
  requirements: Schema.Array(ItemWithSourceEffectSchema),
  constraints: Schema.Array(ItemWithSourceEffectSchema),
  assumptions: Schema.Array(ItemWithSourceEffectSchema),
});

export type DocumentSummaryEffect = typeof DocumentSummaryEffectSchema.Type;
