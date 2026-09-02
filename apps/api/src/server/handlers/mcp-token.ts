import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  McpTokenGenerateResponse,
  McpTokenStatusResponse,
  McpTokenRevokeResponse,
} from "@shipwright/shared/schemas/api";
import { Api } from "@shipwright/shared/api";
import { McpTokenRepository } from "@shipwright/db/repositories/mcp-token-repository";
import { CurrentUser } from "@shipwright/shared/middleware";
import { generateMcpToken as generateRawMcpToken, hashMcpToken } from "@shipwright/auth/mcp-token";
import { toServiceUnavailable } from "./service-unavailable";

export const McpToken = HttpApiBuilder.group(Api, "mcp-token", (handlers) =>
  handlers
    .handle(
      "generateMcpToken",
      Effect.fn("handler/generateMcpToken")(function* () {
        const user = yield* CurrentUser;
        const tokenRepo = yield* McpTokenRepository;

        const rawToken = yield* generateRawMcpToken;
        yield* tokenRepo
          .upsertForUser({ userId: user.id, tokenHash: hashMcpToken(rawToken) })
          .pipe(toServiceUnavailable);

        // The only point in this token's lifetime the raw value ever leaves
        // the server -- not stored, not logged, not returned again.
        return new McpTokenGenerateResponse({ token: rawToken });
      }),
    )
    .handle(
      "getMcpTokenStatus",
      Effect.fn("handler/getMcpTokenStatus")(function* () {
        const user = yield* CurrentUser;
        const tokenRepo = yield* McpTokenRepository;

        const active = yield* tokenRepo.getActiveForUser(user.id).pipe(toServiceUnavailable);
        return new McpTokenStatusResponse({ hasActiveToken: Option.isSome(active) });
      }),
    )
    .handle(
      "revokeMcpToken",
      Effect.fn("handler/revokeMcpToken")(function* () {
        const user = yield* CurrentUser;
        const tokenRepo = yield* McpTokenRepository;

        yield* tokenRepo.revokeForUser(user.id).pipe(toServiceUnavailable);
        return new McpTokenRevokeResponse({ revoked: true });
      }),
    ),
);
