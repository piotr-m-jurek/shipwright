import { Context, Effect, Option, Schema } from "effect";
import {
  createAgentActor,
  restoreAgentActor,
  type AgentActor,
  type DocumentExtractionServices,
} from "./machine";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { AgentSessionSnapshotReader } from "@shipwright/db/repositories/agent-session-snapshot-reader";
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
  const snapshotReader = yield* AgentSessionSnapshotReader;
  const existing = registry.get(sessionId);

  if (existing) {
    return existing;
  }

  // Captured once per actor construction and threaded into both the machine
  // (summarizeDocumentActor) and the snapshot-persistence subscriber below —
  // see machine.ts createAgentMachine's doc comment for the full rationale.
  // Typed concretely (not `never`): this makes getOrRestoreActor itself
  // require DocumentExtractionServices, so its whole caller chain up to
  // wherever the app Layer is provided is compiler-checked, not trusted.
  const services = yield* Effect.context<DocumentExtractionServices>();

  const session = yield* snapshotReader.getUnsafe({ sessionId }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new SessionNotFoundError()),
        onSome: Effect.succeed,
      }),
    ),
  );

  const actor: AgentActor =
    session.xstateSnapshot == null
      ? // No snapshot yet — new session, create a fresh actor.
        createAgentActor(services, { sessionId })
      : yield* restoreAgentActor(services, session.xstateSnapshot).pipe(
          Effect.tapErrorTag("SnapshotValidationError", (err) =>
            // Snapshot schema mismatch — typically caused by a breaking change to
            // MachineContextEffectSchema (e.g. removing a field, changing a type).
            // Old sessions with the prior shape cannot be rehydrated. Mark them as
            // error in the DB so the user sees a clear failed state instead of a
            // silently broken fresh actor with empty context.
            Effect.logWarning(
              `[session-actor] Snapshot validation failed for ${sessionId} — marking session as error`,
              err.cause,
            ).pipe(Effect.andThen(db.updateAgentSession(sessionId, "error"))),
          ),
          Effect.mapError(() => new SessionNotFoundError()),
        );

  yield* wireSnapshotPersistence(actor, sessionId, services);
  actor.start();
  registry.set(sessionId, actor);
  return actor;
});

const wireSnapshotPersistence = Effect.fn("agent/wireSnapshotPersistence")(function* (
  actor: AgentActor,
  sessionId: AgentSessionId,
  services: Context.Context<DocumentExtractionServices>,
) {
  const db = yield* AgentSessionRepository;

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
