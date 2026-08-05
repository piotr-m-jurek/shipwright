import { Metric } from "effect";

/**
 * Central registry of application-level metrics.
 *
 * All instruments are defined here so they can be imported by any pipeline
 * without circular dependencies.
 */

/** Incremented once per successfully created upload session. */
export const sessionCreatedCounter = Metric.counter("shipwright.session.created", {
  description: "Number of upload sessions created",
});

/** Incremented when the analysis pipeline fails (after all retries). */
export const sessionErrorCounter = Metric.counter("shipwright.session.error", {
  description: "Number of analysis pipeline failures",
});

/** Incremented for each document that fails to parse or embed. */
export const documentParseErrorCounter = Metric.counter("shipwright.document.parse_error", {
  description: "Number of document parse/embed failures",
});

/**
 * Histogram of total analysis pipeline duration in milliseconds.
 * Boundaries span from 1 s to ~17 min in exponential steps.
 */
export const pipelineDurationHistogram = Metric.histogram(
  "shipwright.pipeline.duration_ms",
  {
    description: "End-to-end analysis pipeline duration in milliseconds",
    boundaries: Metric.exponentialBoundaries({ start: 1_000, factor: 2, count: 11 }),
    // 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s, 1024s
  },
);
