import { pgTable, text } from "drizzle-orm/pg-core";
import { Effect, pipe, Schema } from "effect";
import { randomUUID } from "node:crypto";

namespace AgentSession {
  const prefix = "ag_sesh";
  const schema = Schema.TemplateLiteral([Schema.Literal(prefix), Schema.String]);
  export const Id = Object.assign(schema, {
    generate: () => `${prefix}_${randomUUID()}`,
  });
  export type Type = typeof Id.Type;
}

export const agentSessions = pgTable("agent_sessions", {
  id: text("id").primaryKey().$defaultFn(AgentSession.Id.generate).$type<AgentSession.Type>(),
});

type AgentSession = (typeof agentSessions.$inferSelect)["id"];

const program = Effect.gen(function* () {
  const result = yield* pipe("ag_sesh_1234", Schema.decodeUnknownEffect(AgentSession.Id));

  return result;
});

Effect.runPromise(program).then((value) => console.log(value));
