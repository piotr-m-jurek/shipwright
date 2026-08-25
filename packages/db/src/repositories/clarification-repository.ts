import { Context, Effect, Layer } from "effect";
import { Spans } from "@shipwright/observability";
import type { QuestionInsert, QuestionSelect, AnswerInsert, AnswerSelect } from "../types";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { questions, answers } from "../schema";
import { DB } from "../index";
import { asc, eq } from "drizzle-orm";

interface Interface {
  createQuestions: (
    data: QuestionInsert[],
  ) => Effect.Effect<QuestionSelect[], EffectDrizzleQueryError>;

  getQuestionsBySessionId: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<QuestionSelect[], EffectDrizzleQueryError>;

  createAnswers: (data: AnswerInsert[]) => Effect.Effect<AnswerSelect[], EffectDrizzleQueryError>;

  getAnswersBySessionId: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<AnswerSelect[], EffectDrizzleQueryError>;
}

export class ClarificationRepository extends Context.Service<ClarificationRepository, Interface>()(
  "@shipwright/api/db/repositories/clarification/ClarificationRepository",
) {
  static readonly layer = Layer.effect(
    ClarificationRepository,
    Effect.gen(function* () {
      const db = yield* DB;

      const createQuestions = Effect.fn("db/createQuestions")(function* (data: QuestionInsert[]) {
        if (data.length === 0) return [] as QuestionSelect[];
        return yield* db.insert(questions).values(data).returning();
      });

      const getQuestionsBySessionId = Effect.fn("db/getQuestionsBySessionId")(function* (sessionId: AgentSessionId) {
        const rows = yield* db
          .select()
          .from(questions)
          .where(eq(questions.sessionId, sessionId))
          .orderBy(asc(questions.orderIndex));
        yield* Effect.annotateCurrentSpan(Spans.dbRowCount(rows.length));
        return rows;
      });

      const createAnswers = Effect.fn("db/createAnswers")(function* (data: AnswerInsert[]) {
        if (data.length === 0) return [] as AnswerSelect[];
        return yield* db.insert(answers).values(data).returning();
      });

      const getAnswersBySessionId = Effect.fn("db/getAnswersBySessionId")(function* (sessionId: AgentSessionId) {
        const rows = yield* db.select().from(answers).where(eq(answers.sessionId, sessionId));
        yield* Effect.annotateCurrentSpan(Spans.dbRowCount(rows.length));
        return rows;
      });

      return {
        createQuestions,
        getQuestionsBySessionId,
        createAnswers,
        getAnswersBySessionId,
      };
    }),
  );
}
