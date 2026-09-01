import { Effect } from "effect";
import { AgentSessionAggregate } from "../agent-session-aggregate";
import type { AgentSessionId, QuestionId } from "@shipwright/shared/domain/ids";
import { Spans } from "@shipwright/observability";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { AnalysisPipelineError } from "../errors";
import { publishForCurrentState } from "../session-process-manager";

export const submitAnswers = Effect.fn("agent/submitAnswers")(
  function* (sessionId: AgentSessionId, rawAnswers: { questionId: QuestionId; text: string }[]) {
    yield* Effect.annotateCurrentSpan(Spans.session(sessionId));

    const db = yield* ClarificationRepository;
    const aggregate = yield* AgentSessionAggregate;

    const result = yield* aggregate.submitAnswers(sessionId, (round) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`[submitAnswers] round ${round}, ${rawAnswers.length} answers`).pipe(
          Effect.annotateLogs({ sessionId, round, answerCount: rawAnswers.length }),
        );
        yield* Effect.annotateCurrentSpan({
          "shipwright.answer.round": round,
          "shipwright.answer.count": rawAnswers.length,
        });

        return yield* db.createAnswers(
          rawAnswers.map((a) => ({
            sessionId,
            questionId: a.questionId,
            text: a.text,
            round,
          })),
        );
      }),
    );

    yield* Effect.logInfo(`[submitAnswers] sufficiency: ${result.sufficient}`).pipe(
      Effect.annotateLogs({ sessionId, round: result.round, sufficient: result.sufficient }),
    );
    yield* Effect.annotateCurrentSpan({ "shipwright.answer.sufficient": result.sufficient });
    yield* Effect.logInfo(
      `[submitAnswers] sent ${result.sufficient ? "ANSWERS_SUFFICIENT" : "ANSWERS_INSUFFICIENT"}`,
    ).pipe(Effect.annotateLogs({ sessionId }));
    yield* Effect.logInfo(
      `[submitAnswers] state after sends: ${String(result.stateAfter)}`,
    ).pipe(Effect.annotateLogs({ sessionId, stateAfter: String(result.stateAfter) }));

    yield* publishForCurrentState(sessionId, result.stateAfter);

    return { sufficient: result.sufficient, round: result.round };
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);
