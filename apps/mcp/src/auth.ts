/**
 * Global auth middleware for the MCP server.
 *
 * MCP clients authenticate with `Authorization: Bearer <better-auth-session-token>`
 * instead of a cookie (there is no browser here). We translate the Bearer token
 * into the cookie header shape better-auth expects, then call the same
 * auth.api.getSession() used by apps/api/src/server/authorization.ts — both
 * apps validate against the same @shipwright/auth singleton and DB.
 *
 * Wraps the entire router (global: true) — MCP session negotiation
 * (`initialize`) also requires a valid token. No anonymous access.
 *
 * Per the MCP authorization spec: invalid or missing tokens MUST receive an
 * HTTP 401 response (not a JSON-RPC error) — this is transport-level auth,
 * handled before any MCP method dispatch.
 */
import { auth } from "@shipwright/auth/auth";
import { CurrentUser } from "@shipwright/shared/middleware";
import { UserId } from "@shipwright/shared/domain/ids";
import { sessionCookieHeader } from "@shipwright/shared/api/session-cookie";
import { Effect, flow, pipe, Predicate, Redacted, Schema, String } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiSecurity } from "effect/unstable/httpapi";

class FailedToGetSessionError extends Schema.TaggedErrorClass<FailedToGetSessionError>()(
  "FailedToGetSessionError",
  {},
) {}

export const McpAuthMiddlewareLayer = HttpRouter.middleware<{
  provides: CurrentUser;
}>()(
  (httpEffect) =>
    pipe(
      HttpApiBuilder.securityDecode(HttpApiSecurity.bearer),
      Effect.filterOrFail(flow(Redacted.value, String.isNonEmpty)),

      Effect.flatMap((token) =>
        Effect.tryPromise({
          try: () => auth.api.getSession({ headers: sessionCookieHeader(token) }),
          catch: () => new FailedToGetSessionError(),
        }).pipe(Effect.filterOrFail(Predicate.isNotNullish)),
      ),

      Effect.flatMap((session) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("mcp auth: providing CurrentUser").pipe(
            Effect.annotateLogs({ userId: session.user.id }),
          );

          return yield* Effect.provideService(httpEffect, CurrentUser, {
            id: UserId.make(session.user.id),
            email: session.user.email,
            name: session.user.name,
          });
        }),
      ),

      Effect.catchTags({
        NoSuchElementError: () =>
          Effect.gen(function* () {
            yield* Effect.logDebug("mcp auth: invalid or expired session token");
            return HttpServerResponse.empty({ status: 401 });
          }),
        FailedToGetSessionError: () =>
          Effect.gen(function* () {
            yield* Effect.logDebug("mcp auth: unable to call auth service to retrieve session");
            return HttpServerResponse.empty({ status: 401 });
          }),
      }),
    ),
  { global: true },
);
