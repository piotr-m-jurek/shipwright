import { Schema } from "effect";

/**
 * Value objects — branded primitives that carry domain constraints beyond
 * what a plain `number` or `string` expresses.
 *
 * Pattern: Schema with brand + optional refinement, type alias derived from it.
 */

export const TokenCount = Schema.Int.pipe(
  Schema.greaterThanOrEqualTo(0),
  Schema.brand("TokenCount"),
);
export type TokenCount = typeof TokenCount.Type;
