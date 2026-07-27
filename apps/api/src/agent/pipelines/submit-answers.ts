import { Effect, pipe } from "effect";
import { runGeneratingPipeline } from "./generation.js";
import { getOrRestoreActor } from "../session-actor.js";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { Spans } from "../../observability/spans.js";
import { DatabaseService } from "../../db/queries.js";
import { AnalysisPipelineError, SessionStateError } from "../errors.js";

export const submitAnswers = Effect.fn("agent/submitAnswers")(
  function* (sessionId: AgentSessionId, rawAnswers: { questionId: string; text: string }[]) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

    const db = yield* DatabaseService;
    const actor = yield* getOrRestoreActor(sessionId);

    const state = actor.getSnapshot().value;
    if (state !== "awaiting_answers") {
      return yield* new SessionStateError({
        message: `Session ${sessionId} is in state '${state}', expected 'awaiting_answers'`,
      });
    }

    const round = actor.getSnapshot().context.round;

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

    // Sufficiency heuristic: all answers non-empty and at least one full round completed.
    const allAnswered = rawAnswers.every((a) => a.text.trim().length > 0);
    const sufficient = allAnswered && round >= 1;

    const currentQuestions = actor.getSnapshot().context.questions;

    if (sufficient) {
      actor.send({ type: "ANSWERS_SUFFICIENT", questions: currentQuestions });
    } else {
      actor.send({ type: "ANSWERS_INSUFFICIENT", questions: currentQuestions });
    }

    const stateAfter = actor.getSnapshot().value as string;
    if (stateAfter === "generating") {
      yield* pipe(
        runGeneratingPipeline(sessionId),
        Effect.tapError((e) =>
          Effect.sync(() => console.error("[session-actor] generating pipeline error:", e)),
        ),
        Effect.forkDetach,
      );
    }

    return { sufficient, round: round + 1 };
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);
