import { Context, Effect, Layer, Option } from "effect";
import type { OutputInsert, OutputSelect } from "../types.ts";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { outputs } from "../schema.ts";
import { DB } from "../index.ts";
import { and, desc, eq } from "drizzle-orm";

interface Interface {
  createOutput: (data: OutputInsert) => Effect.Effect<OutputSelect, EffectDrizzleQueryError>;

  getOutputsBySessionId: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<OutputSelect[], EffectDrizzleQueryError>;

  getLatestOutputByType: (payload: {
    sessionId: AgentSessionId;
    type: OutputSelect["type"];
  }) => Effect.Effect<Option.Option<OutputSelect>, EffectDrizzleQueryError>;
}

export class DbOutput extends Context.Service<DbOutput, Interface>()(
  "@shipwright/api/db/services/output/DbOutput",
) {
  static readonly layer = Layer.effect(
    DbOutput,
    Effect.gen(function* () {
      const db = yield* DB;

      const createOutput = Effect.fnUntraced(function* (data: OutputInsert) {
        const [result] = yield* db.insert(outputs).values(data).returning();
        return result;
      });

      const getOutputsBySessionId = Effect.fnUntraced(function* (sessionId: AgentSessionId) {
        return yield* db
          .select()
          .from(outputs)
          .where(eq(outputs.sessionId, sessionId))
          .orderBy(desc(outputs.version));
      });

      const getLatestOutputByType = Effect.fnUntraced(function* (payload: {
        sessionId: AgentSessionId;
        type: OutputSelect["type"];
      }) {
        const [result] = yield* db
          .select()
          .from(outputs)
          .where(and(eq(outputs.sessionId, payload.sessionId), eq(outputs.type, payload.type)))
          .orderBy(desc(outputs.version))
          .limit(1);

        return Option.fromNullishOr(result);
      });

      return {
        createOutput,
        getOutputsBySessionId,
        getLatestOutputByType,
      };
    }),
  );
}
