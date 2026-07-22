import { Authorization, CurrentUser, Unauthorized } from "@shipwright/shared/middleware.js";
import { Effect, Layer, Redacted } from "effect";
import { auth } from "../auth/auth.js";

export const AuthorizationLayer = Layer.effect(
  Authorization,
  Effect.succeed(
    Authorization.of({
      cookie: Effect.fn(function* (httpEffect, { credential }) {
        const session = yield* Effect.promise(() =>
          auth.api.getSession({
            headers: new Headers({
              cookie: `better-auth.session_token=${Redacted.value(credential)}`,
            }),
          }),
        );

        if (!session) {
          return yield* new Unauthorized({ message: "Invalid or missing session" });
        }

        return yield* Effect.provideService(httpEffect, CurrentUser, {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
        });
      }),
    }),
  ),
);
