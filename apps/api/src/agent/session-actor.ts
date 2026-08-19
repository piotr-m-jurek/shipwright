import { Effect, Option, Schema } from "effect";
import { createAgentActor, restoreAgentActor, type AgentActor } from "./machine";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "shipwright/agent/SessionNotFoundError",
  {},
) {}

const registry = new Map<AgentSessionId, AgentActor>();

// XState states that map to the 'error' value in the Postgres session_status enum.
const ERROR_STATES = new Set([
  "uploading_error",
  "summarizing_error",
  "processing_error",
  "analyzing_error",
  "re_evaluating_error",
  "generating_error",
  "revising_error",
]);

// Resolve XState state value (may be compound object) to a flat DB status string.
// Compound uploading substates both map to "uploading" in the DB — the substate
// detail lives in the XState snapshot, not in the status enum.
function resolveDbStatus(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const parent = keys[0];
      // uploading.uploading_pending_docs and uploading.uploading_docs_ready → "uploading"
      return parent;
    }
  }
  return "error";
}

export const getOrRestoreActor = Effect.fn("agent/getOrRestoreActor")(function* (
  sessionId: AgentSessionId,
) {
  const db = yield* AgentSessionRepository;
  const existing = registry.get(sessionId);

  if (existing) {
    return existing;
  }

  const session = yield* db.getAgentSessionById({ sessionId }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new SessionNotFoundError()),
        onSome: Effect.succeed,
      }),
    ),
  );

  const actor: AgentActor = session.xstateSnapshot == null
    // No snapshot yet — new session, create a fresh actor.
    ? createAgentActor({ sessionId })
    : yield* restoreAgentActor(session.xstateSnapshot).pipe(
        Effect.tapErrorTag("SnapshotValidationError", (err) =>
          // Snapshot schema mismatch — typically caused by a breaking change to
          // MachineContextEffectSchema (e.g. removing a field, changing a type).
          // Old sessions with the prior shape cannot be rehydrated. Mark them as
          // error in the DB so the user sees a clear failed state instead of a
          // silently broken fresh actor with empty context.
          Effect.logWarning(
            `[session-actor] Snapshot validation failed for ${sessionId} — marking session as error`,
            err.cause,
          ).pipe(
            Effect.andThen(db.updateAgentSession(sessionId, "error")),
          ),
        ),
        Effect.mapError(() => new SessionNotFoundError()),
      );

  yield* wireSnapshotPersistence(actor, sessionId);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
});

const wireSnapshotPersistence = Effect.fn("agent/wireSnapshotPersistence")(function* (
  actor: AgentActor,
  sessionId: AgentSessionId,
) {
  const db = yield* AgentSessionRepository;
  const services = yield* Effect.context<never>();

  actor.subscribe((snapshot) => {
    const xstateState = resolveDbStatus(snapshot.value);
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
