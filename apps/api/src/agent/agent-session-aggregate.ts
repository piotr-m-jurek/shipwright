/**
 * AgentSessionAggregate (SHIP-144) — the single place that decides whether a
 * session state transition is legal, and performs it.
 *
 * Before this existed, every pipeline/handler that wanted to advance a
 * session re-implemented the same "read actor.getSnapshot().value, check it
 * against a predicate, actor.send(...) if it passes" shape by hand
 * (submit-answers.ts, session-compute.ts's confirmAnalysis, generation.ts's
 * startRevision, process-uploaded-documents.ts) — the check was a
 * convention, not a guarantee: nothing stopped a new call site from sending
 * an event straight to the actor without consulting the predicate first.
 *
 * This is a Context.Service (not a per-session instance) so it composes with
 * the rest of the app's Layer graph like every other repository here —
 * methods take `sessionId` and load/restore the actor themselves via
 * getOrRestoreActor, the same pattern AgentSessionRepository etc. use.
 *
 * Scope note: this only covers the transitions where application code
 * duplicated a real precondition check before sending an event. It
 * deliberately does NOT wrap run-session-workflow.ts's internal sends
 * (EXTRACTION_STARTED / SUMMARIZATION_DONE / USER_CONFIRM / ANALYSIS_DONE) —
 * those are steps in a multi-stage saga with no externally-duplicated
 * precondition (the machine's own XState guards are the only gate), not a
 * single aggregate command. Folding a whole saga into "one aggregate method"
 * would blur the domain/orchestration boundary this ticket is drawing, not
 * sharpen it.
 *
 * SessionProcessManager's named predicates (isIdle, isAwaitingAnswers, ...)
 * are still the single source of truth for "what does this state value
 * mean" — this service calls them internally rather than duplicating them;
 * it owns "what am I allowed to do from here," a different concern.
 *
 * Queue-publish side effects (SessionProcessManager.publishForCurrentState)
 * deliberately stay OUT of this service and in the calling pipeline — an
 * aggregate method's job is "is this transition legal, make it happen";
 * deciding to enqueue a background job as a consequence of the new state is
 * infrastructure orchestration, not a domain concern.
 */
import { Context, Effect, Layer, Option } from "effect";
import type { QuestionId, AgentSessionId } from "@shipwright/shared/domain/ids";
import { SessionStateError } from "@shipwright/shared/domain/errors";
import { getOrRestoreActor, type SessionNotFoundError } from "./session-actor";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import type { AgentStateValue, DocumentExtractionServices } from "./machine";
import { isIdle, isUploading, isAwaitingAnswers, isComplete } from "./session-process-manager";
import type { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import type { AgentSessionSnapshotReader } from "@shipwright/db/repositories/agent-session-snapshot-reader";

/** Answers already persisted to the DB (with generated ids/round), ready to
 *  hand to the machine as the USER_ANSWERED event payload. */
export interface PersistedAnswer {
  readonly questionId: QuestionId;
  readonly text: string;
  readonly round: number;
}

/** The services getOrRestoreActor itself requires — every method here needs
 *  the same set, since every method starts by loading the actor. */
type ActorServices = AgentSessionRepository | AgentSessionSnapshotReader | DocumentExtractionServices;

/** getOrRestoreActor's own failure modes — every method here can fail this
 *  way too, since every method starts by loading the actor. */
type ActorError = SessionNotFoundError | EffectDrizzleQueryError;

interface Interface {
  /**
   * Idempotent start: idle → (bumps to uploading first) → confirmed;
   * uploading → confirmed; anything past that is a no-op.
   *
   * Returns `Option.none()` when the session was already past idle/uploading
   * (nothing changed, caller should not re-publish a queue job) or
   * `Option.some(stateAfter)` when a real transition happened.
   */
  confirmUpload: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<Option.Option<AgentStateValue>, ActorError, ActorServices>;

  /**
   * Records answers into the clarifying-question loop. Only sends events if
   * the session is currently awaiting_answers — fails with SessionStateError
   * otherwise, before `persistAnswers` ever runs (so a rejected submission
   * never writes orphaned answer rows for a session that can't accept them).
   *
   * `persistAnswers` receives the current round (read from the actor, before
   * the machine advances it) and must return the DB-persisted answers with
   * their generated fields — the caller owns the actual repository write,
   * this service only owns the state-machine transition around it.
   */
  submitAnswers: <E, R>(
    sessionId: AgentSessionId,
    persistAnswers: (round: number) => Effect.Effect<readonly PersistedAnswer[], E, R>,
  ) => Effect.Effect<
    { sufficient: boolean; round: number; stateAfter: AgentStateValue },
    SessionStateError | ActorError | E,
    ActorServices | R
  >;

  /**
   * Requests a revision. Only legal from `complete` — fails with
   * SessionStateError otherwise.
   */
  requestRevision: (
    sessionId: AgentSessionId,
    feedback: string,
  ) => Effect.Effect<AgentStateValue, SessionStateError | ActorError, ActorServices>;

  /**
   * Signals that document processing has finished. No precondition today —
   * the machine's own guards decide what DOCUMENTS_READY means from
   * wherever the session currently is (idle-of-USER_CONFIRM race is
   * legitimate and handled machine-side, not here).
   */
  markDocumentsReady: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<AgentStateValue, ActorError, ActorServices>;
}

export class AgentSessionAggregate extends Context.Service<AgentSessionAggregate, Interface>()(
  "@shipwright/api/agent/AgentSessionAggregate",
) {
  static readonly layer = Layer.succeed(
    AgentSessionAggregate,
    AgentSessionAggregate.of({
      confirmUpload: Effect.fn("agent/AgentSessionAggregate.confirmUpload")(function* (
        sessionId: AgentSessionId,
      ) {
        const actor = yield* getOrRestoreActor(sessionId);
        const stateValue = actor.getSnapshot().value;

        if (!isIdle(stateValue) && !isUploading(stateValue)) {
          return Option.none<AgentStateValue>();
        }

        if (isIdle(stateValue)) {
          actor.send({ type: "UPLOAD_COMPLETE" });
        }
        actor.send({ type: "USER_CONFIRM" });

        return Option.some(actor.getSnapshot().value);
      }),

      submitAnswers: Effect.fn("agent/AgentSessionAggregate.submitAnswers")(function* <E, R>(
        sessionId: AgentSessionId,
        persistAnswers: (round: number) => Effect.Effect<readonly PersistedAnswer[], E, R>,
      ) {
        const actor = yield* getOrRestoreActor(sessionId);
        const state = actor.getSnapshot().value;

        if (!isAwaitingAnswers(state)) {
          return yield* new SessionStateError({
            message: `Session ${sessionId} is in state '${String(state)}', expected 'awaiting_answers'`,
          });
        }

        const round = actor.getSnapshot().context.round;
        const persisted = yield* persistAnswers(round);

        actor.send({
          type: "USER_ANSWERED",
          answers: persisted.map((a) => ({ questionId: a.questionId, text: a.text, round: a.round })),
        });

        // Sufficiency heuristic: all answers non-empty. round is 0-indexed —
        // after USER_ANSWERED the machine increments it, so `round` here is
        // still the pre-send value. Any complete first round is sufficient;
        // the machine's own round-limit guard handles forced progression.
        const sufficient = persisted.every((a) => a.text.trim().length > 0);
        const currentQuestions = actor.getSnapshot().context.questions;

        actor.send(
          sufficient
            ? { type: "ANSWERS_SUFFICIENT", questions: currentQuestions }
            : { type: "ANSWERS_INSUFFICIENT", questions: currentQuestions },
        );

        return { sufficient, round: round + 1, stateAfter: actor.getSnapshot().value };
      }),

      requestRevision: Effect.fn("agent/AgentSessionAggregate.requestRevision")(function* (
        sessionId: AgentSessionId,
        feedback: string,
      ) {
        const actor = yield* getOrRestoreActor(sessionId);
        const state = actor.getSnapshot().value;

        if (!isComplete(state)) {
          return yield* new SessionStateError({
            message: `Session ${sessionId} is in state '${String(state)}', expected 'complete'`,
          });
        }

        actor.send({ type: "REVISION_REQUESTED", feedback });
        return actor.getSnapshot().value;
      }),

      markDocumentsReady: Effect.fn("agent/AgentSessionAggregate.markDocumentsReady")(function* (
        sessionId: AgentSessionId,
      ) {
        const actor = yield* getOrRestoreActor(sessionId);
        actor.send({ type: "DOCUMENTS_READY" });
        return actor.getSnapshot().value;
      }),
    }),
  );
}
