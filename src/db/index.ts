import { ConfigService } from "../config.js";
import { relations } from "./schema.js";
import { Context, Effect, Layer, pipe } from "effect";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as PgClientModule from "@effect/sql-pg/PgClient";
import { types } from "pg";

type DBType = Effect.Success<ReturnType<typeof PgDrizzle.makeWithDefaults>>;

export class DB extends Context.Service<DB, DBType>()("shipwright/db/index/DB") {}

export const PgClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ConfigService;
    return PgClientModule.layer({
      url: config.db.url,
      types: {
        getTypeParser: (typeId, format) => {
          if ([1184, 1114, 1082, 1186, 1231, 1115, 1185, 1187, 1182].includes(typeId)) {
            return (val: any) => val;
          }
          return types.getTypeParser(typeId, format);
        },
      },
    });
  }),
);

// Composed: consumers only need to provide AppDBLayer
export const AppDBLayer = pipe(
  Layer.effect(DB, PgDrizzle.makeWithDefaults({ relations })),
  Layer.provide(PgClientLive),
);

// Fully self-contained layer including ConfigService — for use in scripts/gate tests
export const AppDBLiveLayer = pipe(AppDBLayer, Layer.provide(ConfigService.layer));
