import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Api } from "@shipwright/shared/api.js";
import { GetHealthResponse } from "@shipwright/shared/schemas";

export const PublicApi = HttpApiBuilder.group(Api, "public", (handlers) =>
  handlers.handle("health", () =>
    Effect.succeed(new GetHealthResponse({ status: "ok", version: "0.0.0" })),
  ),
);
