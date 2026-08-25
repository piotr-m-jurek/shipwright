/**
 * Shared observability primitives: OTLP export to Langfuse and span
 * attribute helpers. Extracted from apps/api so apps/mcp can use the same
 * OtlpLayer and Spans attribute keys without an app-to-app dependency —
 * apps never depend on other apps, only on packages.
 *
 * LangfuseClient (prompt registry + score submission) and the LLM span
 * transformer stay in apps/api: they're only used by LLM-calling agent
 * passes, which apps/mcp doesn't have.
 */
export { OtlpLayer } from "./otlp";
export { Spans } from "./spans";
