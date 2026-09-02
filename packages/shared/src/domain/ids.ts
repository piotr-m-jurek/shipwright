import { Schema } from "effect";

// INFO: Idea for fully dumb proof ids
/*
namespace AgentSession {
  const prefix = "ag_sesh";
  const schema = Schema.TemplateLiteral([Schema.Literal(prefix), Schema.String]);
  export const Id = Object.assign(schema, {
    generate: () => `${prefix}_${randomUUID()}`,
  });
  export type Type = typeof Id.Type;
}
*/

export const AgentSessionId = Schema.String.pipe(Schema.brand("AgentSessionId"));
export type AgentSessionId = typeof AgentSessionId.Type;

export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const DocumentId = Schema.String.pipe(Schema.brand("DocumentId"));
export type DocumentId = typeof DocumentId.Type;

export const ChunkId = Schema.String.pipe(Schema.brand("ChunkId"));
export type ChunkId = typeof ChunkId.Type;

export const SummaryId = Schema.String.pipe(Schema.brand("SummaryId"));
export type SummaryId = typeof SummaryId.Type;

export const SummaryItemId = Schema.String.pipe(Schema.brand("SummaryItemId"));
export type SummaryItemId = typeof SummaryItemId.Type;

export const QuestionId = Schema.String.pipe(Schema.brand("QuestionId"));
export type QuestionId = typeof QuestionId.Type;

export const AnswerId = Schema.String.pipe(Schema.brand("AnswerId"));
export type AnswerId = typeof AnswerId.Type;

export const OutputId = Schema.String.pipe(Schema.brand("OutputId"));
export type OutputId = typeof OutputId.Type;

export const McpTokenId = Schema.String.pipe(Schema.brand("McpTokenId"));
export type McpTokenId = typeof McpTokenId.Type;
