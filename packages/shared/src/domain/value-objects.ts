import { Schema } from "effect";

/**
 * Value objects — branded primitives that carry domain constraints beyond
 * what a plain `number` or `string` expresses.
 *
 * Pattern: Schema with brand + optional refinement, type alias derived from it.
 */

export const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("TokenCount"),
);
export type TokenCount = typeof TokenCount.Type;

export const ChunkIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("ChunkIndex"),
);
export type ChunkIndex = typeof ChunkIndex.Type;

export const OutputVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("OutputVersion"),
);
export type OutputVersion = typeof OutputVersion.Type;
