import { Effect } from "effect";
import { getOrRestoreActor } from "../session-actor.js";
import type { AgentSessionId, QuestionId } from "@shipwright/shared/domain/ids";
import { Spans } from "../../observability/spans.js";
import { DbClarification } from "../../db/services/clarification.ts";
import { AnalysisPipelineError, SessionStateError } from "../errors.js";
import { MessageQueue } from "../../queue/index.ts";

export const submitAnswers = Effect.fn("agent/submitAnswers")(
  function* (sessionId: AgentSessionId, rawAnswers: { questionId: QuestionId; text: string }[]) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

    const db = yield* DbClarification;
    const mq = yield* MessageQueue;
    const actor = yield* getOrRestoreActor(sessionId);

    const state = actor.getSnapshot().value;
    if (state !== "awaiting_answers") {
      return yield* new SessionStateError({
        message: `Session ${sessionId} is in state '${state}', expected 'awaiting_answers'`,
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

    const stateAfter = actor.getSnapshot().value as string;
    yield* Effect.logInfo(`[submitAnswers] state after sends: ${stateAfter}`).pipe(
      Effect.annotateLogs({ sessionId, stateAfter }),
    );

    if (stateAfter === "generating") {
      yield* mq.publish("session.generate", { sessionId });
      yield* Effect.logInfo("[submitAnswers] published session.generate").pipe(
        Effect.annotateLogs({ sessionId }),
      );
    }

    return { sufficient, round: round + 1 };
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);
