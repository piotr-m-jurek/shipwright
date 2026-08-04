import { Effect, Option, pipe, Schema } from "effect";
import { createAgentActor, restoreAgentActor, type AgentActor } from "./machine.js";
import { DbAgentSession } from "../db/services/agent-session.ts";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "shipwright/agent/SessionNotFoundError",
  {},
) {}

const registry = new Map<string, AgentActor>();

// XState states that map to the 'error' value in the Postgres session_status enum.
const ERROR_STATES = new Set([
  "uploading_error",
  "processing_error",
  "analyzing_error",
  "re_evaluating_error",
  "generating_error",
  "revising_error",
]);

export const getOrRestoreActor = Effect.fn("agent/getOrRestoreActor")(function* (
  sessionId: AgentSessionId,
) {
  const db = yield* DbAgentSession;
  const existing = registry.get(sessionId);

  if (existing) {
    return existing;
  }

  const session = yield* db.getAgentSessionById({ sessionId }).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new SessionNotFoundError()),
      onSome: Effect.succeed,
    })),
  );

  const actor: AgentActor = yield* pipe(
    Effect.fromNullishOr(session.xstateSnapshot),
    Effect.as(restoreAgentActor(session.xstateSnapshot)),
    Effect.catchTag("NoSuchElementError", () => Effect.succeed(createAgentActor({ sessionId }))),
  );

  yield* wireSnapshotPersistence(actor, sessionId);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
});

const wireSnapshotPersistence = Effect.fnUntraced(function* wireSnapshotPersistence(
  actor: AgentActor,
  sessionId: AgentSessionId,
) {
  const db = yield* DbAgentSession;
  const services = yield* Effect.context<never>();

  actor.subscribe((snapshot) => {
    const xstateState = snapshot.value as string;
    const dbStatus = ERROR_STATES.has(xstateState) ? "error" : xstateState;

    Effect.runForkWith(services)(
      db
        .updateAgentSessionSnapshot(sessionId, dbStatus as any, snapshot)
        .pipe(
          Effect.tapError((err) =>
            Effect.logError(
              `[session-actor] Failed to persist snapshot for ${sessionId} (state: ${xstateState}):`,
              err,
            ),
          ),
        ),
    );
  });
});
