import { Context, Effect, Layer } from "effect";
import type { QuestionInsert, QuestionSelect, AnswerInsert, AnswerSelect } from "../types.ts";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { questions, answers } from "../schema.ts";
import { DB } from "../index.ts";
import { asc, eq } from "drizzle-orm";

interface Interface {
  createQuestions: (
    data: QuestionInsert[],
  ) => Effect.Effect<QuestionSelect[], EffectDrizzleQueryError>;

  getQuestionsBySessionId: (
    sessionId: string,
  ) => Effect.Effect<QuestionSelect[], EffectDrizzleQueryError>;

  createAnswers: (data: AnswerInsert[]) => Effect.Effect<AnswerSelect[], EffectDrizzleQueryError>;

  getAnswersBySessionId: (
    sessionId: string,
  ) => Effect.Effect<AnswerSelect[], EffectDrizzleQueryError>;
}

export class DbClarification extends Context.Service<DbClarification, Interface>()(
  "@shipwright/api/db/services/clarification/DbClarification",
) {
  static readonly layer = Layer.effect(
    DbClarification,
    Effect.gen(function* () {
      const db = yield* DB;

      const createQuestions = Effect.fnUntraced(function* (data: QuestionInsert[]) {
        if (data.length === 0) return [] as QuestionSelect[];
        return yield* db.insert(questions).values(data).returning();
      });

      const getQuestionsBySessionId = Effect.fnUntraced(function* (sessionId: string) {
        return yield* db
          .select()
          .from(questions)
          .where(eq(questions.sessionId, sessionId))
          .orderBy(asc(questions.orderIndex));
      });

      const createAnswers = Effect.fnUntraced(function* (data: AnswerInsert[]) {
        if (data.length === 0) return [] as AnswerSelect[];
        return yield* db.insert(answers).values(data).returning();
      });

      const getAnswersBySessionId = Effect.fnUntraced(function* (sessionId: string) {
        return yield* db.select().from(answers).where(eq(answers.sessionId, sessionId));
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
