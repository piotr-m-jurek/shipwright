/**
 * Global auth middleware for the MCP server.
 *
 * SHIP-115 Step 6: this validates a purpose-scoped MCP token (`mcp_tokens`
 * table via `McpTokenRepository`), NOT the better-auth `session_token`
 * cookie. The two are deliberately separate credentials — see
 * packages/auth/src/mcp-token.ts for why (session_token is HttpOnly and
 * authenticates every apps/api endpoint the browser can reach; reusing it
 * here would have exposed a full-account-privilege credential outside
 * HttpOnly protection). Minted/revoked via apps/api's `POST/GET/DELETE
 * /api/mcp-token` (apps/api/src/server/handlers/mcp-token.ts), surfaced to
 * the user via apps/web's Settings page.
 *
 * Wraps the entire router (global: true) — MCP session negotiation
 * (`initialize`) also requires a valid token. No anonymous access.
 *
 * Per the MCP authorization spec: invalid or missing tokens MUST receive an
 * HTTP 401 response (not a JSON-RPC error) — this is transport-level auth,
 * handled before any MCP method dispatch.
 */
import { McpTokenRepository } from "@shipwright/db/repositories/mcp-token-repository";
import { hashMcpToken } from "@shipwright/auth/mcp-token";
import { CurrentUser } from "@shipwright/shared/middleware";
import { Effect, flow, pipe, Redacted, String } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiSecurity } from "effect/unstable/httpapi";

export const McpAuthMiddlewareLayer = HttpRouter.middleware<{
  provides: CurrentUser;
}>()(
  (httpEffect) =>
    pipe(
      HttpApiBuilder.securityDecode(HttpApiSecurity.bearer),
      Effect.filterOrFail(flow(Redacted.value, String.isNonEmpty)),

      Effect.flatMap((token) =>
        Effect.gen(function* () {
          const tokenRepo = yield* McpTokenRepository;
          const tokenHash = hashMcpToken(Redacted.value(token));
          const owner = yield* tokenRepo.findActiveOwnerByHash(tokenHash).pipe(Effect.orDie);
          return yield* Effect.fromOption(owner);
        }),
      ),

      Effect.flatMap((owner) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("mcp auth: providing CurrentUser").pipe(
            Effect.annotateLogs({ userId: owner.userId }),
          );

          return yield* Effect.provideService(httpEffect, CurrentUser, {
            id: owner.userId,
            email: owner.email,
            name: owner.name,
          });
        }),
      ),

      Effect.catchTag("NoSuchElementError", () =>
        Effect.gen(function* () {
          yield* Effect.logDebug("mcp auth: invalid, missing, or revoked MCP token");
          return HttpServerResponse.empty({ status: 401 });
        }),
      ),
    ),
  { global: true },
);
