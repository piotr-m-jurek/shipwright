import { Context, Effect, Layer, Option } from "effect";
import { InsertAgentSession } from "../types";
import type { AgentSession, SessionStatus } from "@shipwright/shared/domain/types";
import type { AgentSessionId, UserId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { agentSessions } from "../schema";
import { DB } from "../index";
import { and, eq } from "drizzle-orm";
import { toAgentSession } from "../mappers";

interface Interface {
  createAgentSession: (
    data: InsertAgentSession,
  ) => Effect.Effect<AgentSession, EffectDrizzleQueryError>;

  updateAgentSession: (
    sessionId: AgentSessionId,
    status: SessionStatus,
    errorReason?: string | null,
  ) => Effect.Effect<AgentSession, EffectDrizzleQueryError>;

  updateAgentSessionSnapshot: (
    sessionId: AgentSessionId,
    status: SessionStatus,
    xstateSnapshot: unknown,
  ) => Effect.Effect<void, EffectDrizzleQueryError>;

  getAgentSessionById: (payload: {
    sessionId: AgentSessionId;
  }) => Effect.Effect<Option.Option<AgentSession>, EffectDrizzleQueryError>;

  getAgentSessionByIdForUser: (payload: {
    sessionId: AgentSessionId;
    userId: UserId;
  }) => Effect.Effect<Option.Option<AgentSession>, EffectDrizzleQueryError>;

  deleteAgentSession: (sessionId: AgentSessionId) => Effect.Effect<void, EffectDrizzleQueryError>;
}

export class AgentSessionRepository extends Context.Service<AgentSessionRepository, Interface>()(
  "@shipwright/api/db/repositories/agent-session/AgentSessionRepository",
) {
  static readonly layer = Layer.effect(
    AgentSessionRepository,
    Effect.gen(function* () {
      const db = yield* DB;

      const createAgentSession = Effect.fn("db/createAgentSession")(function* (data: InsertAgentSession) {
        const [result] = yield* db.insert(agentSessions).values(data).returning();

        return toAgentSession(result);
      });

      const updateAgentSession = Effect.fn("db/updateAgentSession")(function* (
        sessionId: AgentSessionId,
        status: SessionStatus,
        errorReason?: string | null,
      ) {
        const [result] = yield* db
          .update(agentSessions)
          .set({ status, ...(errorReason !== undefined ? { errorReason } : {}) })
          .where(eq(agentSessions.id, sessionId))
          .returning();

        return toAgentSession(result);
      });

      const updateAgentSessionSnapshot = Effect.fn("db/updateAgentSessionSnapshot")(function* (
        sessionId: AgentSessionId,
        status: SessionStatus,
        xstateSnapshot: unknown,
      ) {
        yield* db
          .update(agentSessions)
          .set({ status, xstateSnapshot: xstateSnapshot as any })
          .where(eq(agentSessions.id, sessionId));
      });

      const getAgentSessionById = Effect.fn("db/getAgentSessionById")(function* (payload: {
        sessionId: AgentSessionId;
      }) {
        const results = yield* db
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.id, payload.sessionId));

        return Option.fromIterable(results).pipe(Option.map(toAgentSession));
      });

      const getAgentSessionByIdForUser = Effect.fn("db/getAgentSessionByIdForUser")(function* (payload: {
        sessionId: AgentSessionId;
        userId: UserId;
      }) {
        const results = yield* db
          .select()
          .from(agentSessions)
          .where(
            and(eq(agentSessions.id, payload.sessionId), eq(agentSessions.userId, payload.userId)),
          );

        return Option.fromIterable(results).pipe(Option.map(toAgentSession));
      });

      const deleteAgentSession = Effect.fn("db/deleteAgentSession")(function* (sessionId: AgentSessionId) {
        yield* db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
      });

      return {
        createAgentSession,
        updateAgentSession,
        updateAgentSessionSnapshot,
        getAgentSessionById,
        getAgentSessionByIdForUser,
        deleteAgentSession,
      };
    }),
  );
}
