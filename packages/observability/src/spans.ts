import { Option } from "effect";
import type { AgentSessionId, DocumentId, UserId } from "@shipwright/shared/domain/ids";

/** Spread an optional value as `{ [key]: value }` or `{}`. */
const optionalAttr = <K extends string, V>(key: K, value: V | undefined): Record<K, V> | {} =>
  Option.match(Option.fromUndefinedOr(value), {
    onNone: () => ({}),
    onSome: (v) => ({ [key]: v }) as Record<K, V>,
  });

export const Spans = {
  user: (userId: UserId) => ({
    "langfuse.user.id": userId,
    "shipwright.user.id": userId,
  }),

  session: (sessionId: AgentSessionId) => ({
    "langfuse.session.id": sessionId,
    "shipwright.session.id": sessionId,
  }),

  llm: (opts: {
    model: string | undefined;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    cacheReadTokens?: number | undefined;
  }) => ({
    ...optionalAttr("llm.model", opts.model),
    ...optionalAttr("llm.input_tokens", opts.inputTokens),
    ...optionalAttr("llm.output_tokens", opts.outputTokens),
    ...optionalAttr("llm.cache_read_tokens", opts.cacheReadTokens),
  }),

  document: (opts: { filename: string; id?: DocumentId }) => ({
    "shipwright.document.filename": opts.filename,
    ...optionalAttr("shipwright.document.id", opts.id),
  }),

  chunk: (index: number) => ({
    "shipwright.chunk.index": index,
  }),

  pass: (name: string) => ({
    "shipwright.pass": name,
  }),

  counts: (opts: {
    documents?: number;
    answers?: number;
    feedbackLength?: number;
    conflicts?: number;
    gaps?: number;
    ambiguities?: number;
  }) => ({
    ...optionalAttr("shipwright.document.count", opts.documents),
    ...optionalAttr("shipwright.answer.count", opts.answers),
    ...optionalAttr("shipwright.revision.feedback.length", opts.feedbackLength),
    ...optionalAttr("shipwright.gap.conflicts", opts.conflicts),
    ...optionalAttr("shipwright.gap.gaps", opts.gaps),
    ...optionalAttr("shipwright.gap.ambiguities", opts.ambiguities),
  }),

  output: (opts: { chars: number }) => ({
    "shipwright.output.chars": opts.chars,
  }),

  /** A prompt fetched from the Langfuse prompt registry (vs. hardcoded fallback). */
  prompt: (opts: { name: string; version: number }) => ({
    "langfuse.observation.prompt.name": opts.name,
    "langfuse.observation.prompt.version": opts.version,
  }),

  /** Row count returned by a DB repository query. */
  dbRowCount: (count: number) => ({
    "db.row_count": count,
  }),

  uploadCount: (count: number) => ({
    "shipwright.upload.count": count,
  }),

  mcpResourceType: (type: string) => ({
    "shipwright.mcp.resource.type": type,
  }),

  mcpResultCount: (count: number) => ({
    "shipwright.mcp.result_count": count,
  }),

  mcpAuthOutcome: (outcome: "success" | "invalid_token" | "store_unavailable") => ({
    "shipwright.mcp.auth.outcome": outcome,
  }),

  embedding: (opts: {
    provider: string;
    chunkCount?: number;
    textLength?: number;
    vectorDimensions?: number;
    inputTokens?: number | undefined;
  }) => ({
    "shipwright.embedding.provider": opts.provider,
    ...optionalAttr("shipwright.embedding.chunk_count", opts.chunkCount),
    ...optionalAttr("shipwright.embedding.text_length", opts.textLength),
    ...optionalAttr("shipwright.embedding.vector_dimensions", opts.vectorDimensions),
    ...optionalAttr("shipwright.embedding.input_tokens", opts.inputTokens),
  }),
} as const;
