import { Context, Effect, Layer, Option } from "effect";
import { InsertAgentSession, SelectAgentSession } from "../types.ts";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { agentSessions } from "../schema.ts";
import { DB } from "../index.ts";
import { and, eq } from "drizzle-orm";

interface Interface {
  createAgentSession: (
    data: InsertAgentSession,
  ) => Effect.Effect<SelectAgentSession, EffectDrizzleQueryError>;

  updateAgentSession: (
    sessionId: AgentSessionId,
    status: SelectAgentSession["status"],
  ) => Effect.Effect<SelectAgentSession, EffectDrizzleQueryError>;

  updateAgentSessionSnapshot: (
    sessionId: AgentSessionId,
    status: SelectAgentSession["status"],
    xstateSnapshot: unknown,
  ) => Effect.Effect<void, EffectDrizzleQueryError>;

  getAgentSessionById: (payload: {
    sessionId: AgentSessionId;
  }) => Effect.Effect<Option.Option<SelectAgentSession>, EffectDrizzleQueryError>;

  getAgentSesionByIdForUser: (payload: {
    sessionId: AgentSessionId;
    userId: string;
  }) => Effect.Effect<Option.Option<SelectAgentSession>, EffectDrizzleQueryError>;

  deleteAgentSession: (sessionId: AgentSessionId) => Effect.Effect<void, EffectDrizzleQueryError>;
}

export class AgentSession extends Context.Service<AgentSession, Interface>()(
  "@shipwright/api/db/services/agent-session/AgentSession",
) {
  static readonly layer = Layer.effect(
    AgentSession,
    Effect.gen(function* () {
      const db = yield* DB;

      const createAgentSession = Effect.fnUntraced(function* (data: InsertAgentSession) {
        const [result] = yield* db.insert(agentSessions).values(data).returning();

        return result;
      });

      const updateAgentSession = Effect.fnUntraced(function* (
        sessionId: AgentSessionId,
        status: SelectAgentSession["status"],
      ) {
        const [result] = yield* db
          .update(agentSessions)
          .set({ status })
          .where(eq(agentSessions.id, sessionId))
          .returning();

        return result;
      });

      const updateAgentSessionSnapshot = Effect.fnUntraced(function* (
        sessionId: AgentSessionId,
        status: SelectAgentSession["status"],
        xstateSnapshot: unknown,
      ) {
        yield* db
          .update(agentSessions)
          .set({ status, xstateSnapshot: xstateSnapshot as any })
          .where(eq(agentSessions.id, sessionId));
      });

      const getAgentSessionById = Effect.fnUntraced(function* (payload: {
        sessionId: AgentSessionId;
      }) {
        const results = yield* db
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.id, payload.sessionId));

        return Option.fromIterable(results);
      });

      const getAgentSesionByIdForUser = Effect.fnUntraced(function* (payload: {
        sessionId: AgentSessionId;
        userId: string;
      }) {
        const results = yield* db
          .select()
          .from(agentSessions)
          .where(
            and(eq(agentSessions.id, payload.sessionId), eq(agentSessions.userId, payload.userId)),
          );

        return Option.fromIterable(results);
      });

      const deleteAgentSession = Effect.fnUntraced(function* (sessionId: AgentSessionId) {
        yield* db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
      });

      return {
        createAgentSession,
        updateAgentSession,
        updateAgentSessionSnapshot,
        getAgentSessionById,
        getAgentSesionByIdForUser,
        deleteAgentSession,
      };
    }),
  );
}
