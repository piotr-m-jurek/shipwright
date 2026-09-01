import { Context, Effect, Layer, Option } from "effect";
import type { AgentSessionId, UserId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { agentSessions } from "../schema";
import { DB } from "../index";
import { and, eq, type SQL } from "drizzle-orm";
import { toAgentSessionSnapshot, type AgentSessionSnapshot } from "../mappers";

/**
 * Internal machinery, not a domain accessor. Reads an AgentSession row
 * together with its raw XState snapshot — a concern deliberately excluded
 * from the AgentSession domain type and from AgentSessionRepository's
 * interface, so it isn't just another peer method sitting next to the
 * normal domain-typed getters where unrelated code could reach for it out
 * of convenience.
 *
 * `get` enforces ownership — use it whenever this is the first/only check
 * on the request path (session-compute.ts's getSessionDebug). `getUnsafe`
 * skips the ownership filter entirely and must only be called once an
 * AgentSessionRepository ownership check has already run earlier in the
 * same request: actor restoration (session-actor.ts's getOrRestoreActor)
 * and session-debug-sse.ts's buildDebugPayload, both downstream of a prior
 * getAgentSessionByIdForUser check.
 */
interface Interface {
  get: (payload: {
    sessionId: AgentSessionId;
    userId: UserId;
  }) => Effect.Effect<Option.Option<AgentSessionSnapshot>, EffectDrizzleQueryError>;
  getUnsafe: (payload: {
    sessionId: AgentSessionId;
  }) => Effect.Effect<Option.Option<AgentSessionSnapshot>, EffectDrizzleQueryError>;
}

export class AgentSessionSnapshotReader extends Context.Service<
  AgentSessionSnapshotReader,
  Interface
>()("@shipwright/api/db/repositories/agent-session-snapshot/AgentSessionSnapshotReader") {
  static readonly layer = Layer.effect(
    AgentSessionSnapshotReader,
    Effect.gen(function* () {
      const db = yield* DB;

      const selectByCondition = (condition: SQL | undefined) =>
        Effect.gen(function* () {
          const results = yield* db.select().from(agentSessions).where(condition);
          return Option.fromIterable(results).pipe(Option.map(toAgentSessionSnapshot));
        });

      const get = Effect.fn("db/getAgentSessionSnapshot")(function* (payload: {
        sessionId: AgentSessionId;
        userId: UserId;
      }) {
        return yield* selectByCondition(
          and(eq(agentSessions.id, payload.sessionId), eq(agentSessions.userId, payload.userId)),
        );
      });

      const getUnsafe = Effect.fn("db/getAgentSessionSnapshotUnsafe")(function* (payload: {
        sessionId: AgentSessionId;
      }) {
        return yield* selectByCondition(eq(agentSessions.id, payload.sessionId));
      });

      return { get, getUnsafe };
    }),
  );
}
