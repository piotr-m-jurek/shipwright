import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { auth } from "@shipwright/auth/auth";

export const AuthRouteLayer = HttpRouter.add("*", "/api/auth/*", (req) =>
  Effect.gen(function* () {
    // HttpServerRequest.toWeb is runtime-agnostic (returns the underlying
    // request unchanged when it's already a Web Request, e.g. on Bun) —
    // keeps this route free of a @effect/platform-bun dependency so
    // server.ts (and anything importing it, like server.test.ts) doesn't
    // pull in Bun-only code merely by loading this module.
    const webRequest = yield* HttpServerRequest.toWeb(req).pipe(Effect.orDie);
    const response = yield* Effect.promise(() => auth.handler(webRequest));
    return HttpServerResponse.fromWeb(response);
  }),
);
