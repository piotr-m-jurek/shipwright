import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Api } from "@shipwright/shared/api.js";

export const PublicApi = HttpApiBuilder.group(Api, "public", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ status: "ok", version: "0.0.0" })),
);
