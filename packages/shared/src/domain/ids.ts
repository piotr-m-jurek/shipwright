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
