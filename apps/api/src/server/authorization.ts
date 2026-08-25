import { Authorization, CurrentUser, Unauthorized } from "@shipwright/shared/middleware";
import { UserId } from "@shipwright/shared/domain/ids";
import { sessionCookieHeader } from "@shipwright/shared/api/session-cookie";
import { Effect, Layer } from "effect";
import { auth } from "@shipwright/auth/auth";
import { Spans } from "@shipwright/observability";

export const AuthorizationLayer = Layer.succeed(
  Authorization,
  Authorization.of({
    cookie: (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const session = yield* Effect.tryPromise({
          try: () => auth.api.getSession({ headers: sessionCookieHeader(credential) }),
          catch: () => new Unauthorized({ message: "Session lookup failed" }),
        });

        if (!session) {
          return yield* new Unauthorized({ message: "Invalid or missing session" });
        }
        const userId = UserId.make(session.user.id);

        yield* Effect.logDebug("auth: providing CurrentUser").pipe(
          Effect.annotateLogs({ userId: session.user.id }),
        );

        // Propagate the authenticated user ID to the current OTLP span so
        // Langfuse can group cost/latency per user across all HTTP routes.
        yield* Effect.annotateCurrentSpan(Spans.user(userId));

        return yield* Effect.provideService(httpEffect, CurrentUser, {
          id: userId,
          email: session.user.email,
          name: session.user.name,
        });
      }),
  }),
);
