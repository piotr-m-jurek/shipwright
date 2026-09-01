import { Effect } from "effect";
import { getOrRestoreActor } from "../session-actor";
import type { AgentSessionId, QuestionId } from "@shipwright/shared/domain/ids";
import { Spans } from "@shipwright/observability";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { AnalysisPipelineError } from "../errors";
import { SessionStateError } from "@shipwright/shared/domain/errors";
import { isAwaitingAnswers, publishForCurrentState } from "../session-process-manager";

export const submitAnswers = Effect.fn("agent/submitAnswers")(
  function* (sessionId: AgentSessionId, rawAnswers: { questionId: QuestionId; text: string }[]) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

    const db = yield* ClarificationRepository;
    const actor = yield* getOrRestoreActor(sessionId);

    const state = actor.getSnapshot().value;
    if (!isAwaitingAnswers(state)) {
      return yield* new SessionStateError({
        message: `Session ${sessionId} is in state '${String(state)}', expected 'awaiting_answers'`,
      });
    }

    const round = actor.getSnapshot().context.round;
    yield* Effect.logInfo(`[submitAnswers] round ${round}, ${rawAnswers.length} answers`).pipe(
      Effect.annotateLogs({ sessionId, round, answerCount: rawAnswers.length }),
    );
    yield* Effect.annotateCurrentSpan({
      "shipwright.answer.round": round,
      "shipwright.answer.count": rawAnswers.length,
    });

    const persistedAnswers = yield* db.createAnswers(
      rawAnswers.map((a) => ({
        sessionId,
        questionId: a.questionId,
        text: a.text,
        round,
      })),
    );

    actor.send({
      type: "USER_ANSWERED",
      answers: persistedAnswers.map((a) => ({
        questionId: a.questionId,
        text: a.text,
        round: a.round,
      })),
    });

    // Sufficiency heuristic: all answers non-empty.
    // round is 0-indexed (0 = first round). After USER_ANSWERED the machine
    // increments it, so by the time we read the snapshot here it is still the
    // pre-send value. We consider any complete first round sufficient — the
    // round-limit guard in the machine handles forced progression at round 2.
    const allAnswered = rawAnswers.every((a) => a.text.trim().length > 0);
    const sufficient = allAnswered;

    yield* Effect.logInfo(`[submitAnswers] sufficiency: ${sufficient}`).pipe(
      Effect.annotateLogs({ sessionId, round, sufficient }),
    );
    yield* Effect.annotateCurrentSpan({ "shipwright.answer.sufficient": sufficient });

    const currentQuestions = actor.getSnapshot().context.questions;

    if (sufficient) {
      actor.send({ type: "ANSWERS_SUFFICIENT", questions: currentQuestions });
      yield* Effect.logInfo("[submitAnswers] sent ANSWERS_SUFFICIENT").pipe(
        Effect.annotateLogs({ sessionId }),
      );
    } else {
      actor.send({ type: "ANSWERS_INSUFFICIENT", questions: currentQuestions });
      yield* Effect.logInfo("[submitAnswers] sent ANSWERS_INSUFFICIENT").pipe(
        Effect.annotateLogs({ sessionId }),
      );
    }

    const stateAfter = actor.getSnapshot().value;
    yield* Effect.logInfo(`[submitAnswers] state after sends: ${String(stateAfter)}`).pipe(
      Effect.annotateLogs({ sessionId, stateAfter: String(stateAfter) }),
    );

    yield* publishForCurrentState(sessionId, stateAfter);

    return { sufficient, round: round + 1 };
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);
