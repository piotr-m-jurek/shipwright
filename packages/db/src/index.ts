import { ConfigService } from "@shipwright/config";
import { relations } from "./schema";
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
        // 1114/1082 (timestamp, date, no timezone) and their array/interval/numeric
        // variants are passed through raw rather than parsed: pg's default parser
        // for tz-less timestamp/date interprets the value in the server process's
        // local timezone, which silently corrupts values whenever that's not UTC.
        // 1184/1185 (timestamptz, timestamptz[]) are deliberately excluded — pg
        // parses those correctly (UTC-aware) with no such footgun, and effect-mq's
        // DrizzleJobStore (packages/queue) relies on getting real `Date` objects
        // back for its timestamptz columns (run_at, enqueued_at, ...) since it
        // shares this same connection pool (see packages/queue/src/job-store.ts).
        getTypeParser: (typeId, format) => {
          if ([1114, 1082, 1186, 1231, 1115, 1187, 1182].includes(typeId)) {
            return (val: any) => val;
          }
          return types.getTypeParser(typeId, format);
        },
      },
    });
  }),
);

// Composed: provides DB + PgClient + SqlClient.
// Layer.provideMerge keeps PgClientLive's outputs (PgClient, SqlClient) visible
// to consumers so that SqlClient.withTransaction works in any Effect that
// depends on this layer.
export const AppDBLayer = pipe(
  Layer.effect(DB, PgDrizzle.makeWithDefaults({ relations })),
  Layer.provideMerge(PgClientLive),
);

// Fully self-contained layer including ConfigService — for use in scripts/gate tests
export const AppDBLiveLayer = pipe(AppDBLayer, Layer.provide(ConfigService.layer));
