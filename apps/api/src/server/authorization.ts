import { Authorization, CurrentUser, Unauthorized } from "@shipwright/shared/middleware.js";
import { Effect, Layer, Redacted } from "effect";
import { auth } from "../auth/auth.js";

export const AuthorizationLayer = Layer.succeed(
  Authorization,
  Authorization.of({
    cookie: (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const session = yield* Effect.tryPromise({
          try: () =>
            auth.api.getSession({
              headers: new Headers({
                cookie: `better-auth.session_token=${Redacted.value(credential)}`,
              }),
            }),
          catch: () => new Unauthorized({ message: "Session lookup failed" }),
        });

        if (!session) {
          return yield* new Unauthorized({ message: "Invalid or missing session" });
        }
        yield* Effect.logInfo("auth: providing CurrentUser");

        return yield* Effect.provideService(httpEffect, CurrentUser, {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
        });
      }),
  }),
);
