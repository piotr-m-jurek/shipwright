import { Context, Effect, Layer } from "effect";
import { Spans } from "@shipwright/observability";
import type { QuestionInsert, AnswerInsert } from "../types";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { questions, answers } from "../schema";
import { DB } from "../index";
import { asc, eq } from "drizzle-orm";
import type { Answer, Question } from "@shipwright/shared/domain/types";
import { toAnswer, toQuestion } from "../mappers";

interface Interface {
  createQuestions: (data: QuestionInsert[]) => Effect.Effect<Question[], EffectDrizzleQueryError>;

  getQuestionsBySessionId: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<Question[], EffectDrizzleQueryError>;

  createAnswers: (data: AnswerInsert[]) => Effect.Effect<Answer[], EffectDrizzleQueryError>;

  getAnswersBySessionId: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<Answer[], EffectDrizzleQueryError>;
}

export class ClarificationRepository extends Context.Service<ClarificationRepository, Interface>()(
  "@shipwright/api/db/repositories/clarification/ClarificationRepository",
) {
  static readonly layer = Layer.effect(
    ClarificationRepository,
    Effect.gen(function* () {
      const db = yield* DB;

      const createQuestions = Effect.fn("db/createQuestions")(function* (data: QuestionInsert[]) {
        if (data.length === 0) return [];
        const rows = yield* db.insert(questions).values(data).returning();
        return rows.map(toQuestion);
      });

      const getQuestionsBySessionId = Effect.fn("db/getQuestionsBySessionId")(function* (sessionId: AgentSessionId) {
        const rows = yield* db
          .select()
          .from(questions)
          .where(eq(questions.sessionId, sessionId))
          .orderBy(asc(questions.orderIndex));
        yield* Effect.annotateCurrentSpan(Spans.dbRowCount(rows.length));
        return rows.map(toQuestion);
      });

      const createAnswers = Effect.fn("db/createAnswers")(function* (data: AnswerInsert[]) {
        if (data.length === 0) return [];
        const rows = yield* db.insert(answers).values(data).returning();
        return rows.map(toAnswer);
      });

      const getAnswersBySessionId = Effect.fn("db/getAnswersBySessionId")(function* (sessionId: AgentSessionId) {
        const rows = yield* db.select().from(answers).where(eq(answers.sessionId, sessionId));
        yield* Effect.annotateCurrentSpan(Spans.dbRowCount(rows.length));
        return rows.map(toAnswer);
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
