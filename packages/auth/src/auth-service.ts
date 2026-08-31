/**
 * AuthService — the only sanctioned way to reach Better Auth from Effect
 * code. Wraps the two operations callers actually need (session lookup,
 * request handling) so `auth` (auth.ts's makeAuth output) is never imported
 * directly outside this file — callers can be mocked/swapped at this seam.
 */
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { Option } from "effect";
import { ConfigService } from "@shipwright/config";
import { type Auth, makeAuth } from "./auth";

export class AuthSessionLookupError extends Schema.TaggedErrorClass<AuthSessionLookupError>()(
  "shipwright/auth/AuthSessionLookupError",
  { cause: Schema.Defect() },
) {}

type GetSessionParams = Parameters<Auth["api"]["getSession"]>[0];
type GetSessionResult = Awaited<ReturnType<Auth["api"]["getSession"]>>;

interface Interface {
  /** Look up the current session from request headers. Resolves to null when there is none. */
  getSession: (params: GetSessionParams) => Effect.Effect<GetSessionResult, AuthSessionLookupError>;
  /** Hand a request to Better Auth's own route handler (sign-in, callbacks, etc). */
  handle: (request: Request) => Effect.Effect<Response>;
}

export class AuthService extends Context.Service<AuthService, Interface>()(
  "shipwright/auth/AuthService",
) {
  static readonly layer = Layer.effect(
    AuthService,
    Effect.gen(function* () {
      const config = yield* ConfigService;

      const auth = makeAuth({
        databaseUrl: Redacted.value(config.db.url),
        allowedOrigins: config.server.allowedOrigins,
        github: Option.match(config.auth.github, {
          onNone: () => undefined,
          onSome: (g) => ({ clientId: g.clientId, clientSecret: Redacted.value(g.clientSecret) }),
        }),
        google: Option.match(config.auth.google, {
          onNone: () => undefined,
          onSome: (g) => ({ clientId: g.clientId, clientSecret: Redacted.value(g.clientSecret) }),
        }),
      });

      return AuthService.of({
        getSession: (params) =>
          Effect.tryPromise({
            try: () => auth.api.getSession(params),
            catch: (cause) => new AuthSessionLookupError({ cause }),
          }),
        handle: (request) => Effect.promise(() => auth.handler(request)),
      });
    }),
  );
}
