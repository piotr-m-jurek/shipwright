import { Context, Effect, Layer, Option } from "effect";
import { Spans } from "@shipwright/observability";
import type { OutputInsert } from "../types";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { outputs } from "../schema";
import { DB } from "../index";
import { and, desc, eq } from "drizzle-orm";
import type { Output, OutputType } from "@shipwright/shared/domain/types";
import { toOutput } from "../mappers";

interface Interface {
  createOutput: (data: OutputInsert) => Effect.Effect<Output, EffectDrizzleQueryError>;

  getOutputsBySessionId: (
    sessionId: AgentSessionId,
  ) => Effect.Effect<Output[], EffectDrizzleQueryError>;

  getLatestOutputByType: (payload: {
    sessionId: AgentSessionId;
    type: OutputType;
  }) => Effect.Effect<Option.Option<Output>, EffectDrizzleQueryError>;
}

export class OutputRepository extends Context.Service<OutputRepository, Interface>()(
  "@shipwright/api/db/repositories/output/OutputRepository",
) {
  static readonly layer = Layer.effect(
    OutputRepository,
    Effect.gen(function* () {
      const db = yield* DB;

      const createOutput = Effect.fn("db/createOutput")(function* (data: OutputInsert) {
        const [result] = yield* db.insert(outputs).values(data).returning();
        return toOutput(result);
      });

      const getOutputsBySessionId = Effect.fn("db/getOutputsBySessionId")(function* (sessionId: AgentSessionId) {
        const rows = yield* db
          .select()
          .from(outputs)
          .where(eq(outputs.sessionId, sessionId))
          .orderBy(desc(outputs.version));
        yield* Effect.annotateCurrentSpan(Spans.dbRowCount(rows.length));
        return rows.map(toOutput);
      });

      const getLatestOutputByType = Effect.fn("db/getLatestOutputByType")(function* (payload: {
        sessionId: AgentSessionId;
        type: OutputType;
      }) {
        const [result] = yield* db
          .select()
          .from(outputs)
          .where(and(eq(outputs.sessionId, payload.sessionId), eq(outputs.type, payload.type)))
          .orderBy(desc(outputs.version))
          .limit(1);

        return Option.fromNullishOr(result).pipe(Option.map(toOutput));
      });

      return {
        createOutput,
        getOutputsBySessionId,
        getLatestOutputByType,
      };
    }),
  );
}
