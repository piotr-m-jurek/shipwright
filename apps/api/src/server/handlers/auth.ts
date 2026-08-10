import { BunHttpServerRequest } from "@effect/platform-bun";
import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { auth } from "../../auth/auth";

export const AuthRouteLayer = HttpRouter.add("*", "/api/auth/*", (req) =>
  Effect.gen(function* () {
    // BunHttpServerRequest gives us the Web Request directly — no manual conversion needed.
    const webRequest = BunHttpServerRequest.toBunServerRequest(req);
    const response = yield* Effect.promise(() => auth.handler(webRequest));
    return HttpServerResponse.fromWeb(response);
  }),
);
