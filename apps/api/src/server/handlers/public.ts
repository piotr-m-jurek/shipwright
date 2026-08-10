import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Api } from "@shipwright/shared/api";
import { GetHealthResponse } from "@shipwright/shared/schemas";
import { ServiceUnavailableError } from "@shipwright/shared/domain/errors";

const VERSION = "1.0.0";

export const PublicApi = HttpApiBuilder.group(Api, "public", (handlers) =>
  handlers.handle("health", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`SELECT 1`.pipe(
        Effect.mapError(
          (cause) => new ServiceUnavailableError({ message: `DB unreachable: ${String(cause)}` }),
        ),
      );
      return new GetHealthResponse({ status: "ok", version: VERSION });
    }),
  ),
);
