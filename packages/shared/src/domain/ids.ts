import { Brand, Schema } from "effect";

export const AgentSessionIdSchema = Schema.String.pipe(Schema.brand("AgentSessionId"));
export type AgentSessionId = typeof AgentSessionIdSchema.Type;
export const AgentSessionId = Brand.nominal<AgentSessionId>();
