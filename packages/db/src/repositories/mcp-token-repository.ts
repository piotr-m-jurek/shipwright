import { Context, Effect, Layer, Option } from "effect";
import type { McpTokenSelect } from "../types";
import type { UserId } from "@shipwright/shared/domain/ids";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { mcpTokens, users } from "../schema";
import { DB } from "../index";
import { and, eq, isNull } from "drizzle-orm";

interface ActiveTokenOwner {
  userId: UserId;
  email: string;
  name: string;
}

interface Interface {
  /**
   * Creates or replaces the caller's single MCP token. One active token per
   * user (enforced by the `userId` unique constraint on `mcp_tokens`) —
   * generating a new one silently invalidates any previous one for that user.
   */
  upsertForUser: (payload: {
    userId: UserId;
    tokenHash: string;
  }) => Effect.Effect<McpTokenSelect, EffectDrizzleQueryError>;

  revokeForUser: (userId: UserId) => Effect.Effect<void, EffectDrizzleQueryError>;

  /** For the Settings page's "do you have an active token" check — never exposes the raw value (it isn't stored). */
  getActiveForUser: (
    userId: UserId,
  ) => Effect.Effect<Option.Option<McpTokenSelect>, EffectDrizzleQueryError>;

  /**
   * Looks up the owning user for a hashed bearer token, filtering out
   * revoked tokens. Used by apps/mcp/src/auth.ts on every request.
   */
  findActiveOwnerByHash: (
    tokenHash: string,
  ) => Effect.Effect<Option.Option<ActiveTokenOwner>, EffectDrizzleQueryError>;
}

export class McpTokenRepository extends Context.Service<McpTokenRepository, Interface>()(
  "@shipwright/api/db/repositories/mcp-token/McpTokenRepository",
) {
  static readonly layer = Layer.effect(
    McpTokenRepository,
    Effect.gen(function* () {
      const db = yield* DB;

      const upsertForUser = Effect.fn("db/upsertMcpTokenForUser")(function* (payload: {
        userId: UserId;
        tokenHash: string;
      }) {
        const [result] = yield* db
          .insert(mcpTokens)
          .values({ userId: payload.userId, tokenHash: payload.tokenHash })
          .onConflictDoUpdate({
            target: mcpTokens.userId,
            set: {
              tokenHash: payload.tokenHash,
              createdAt: new Date(),
              revokedAt: null,
              lastUsedAt: null,
            },
          })
          .returning();
        return result;
      });

      const revokeForUser = Effect.fn("db/revokeMcpTokenForUser")(function* (userId: UserId) {
        yield* db
          .update(mcpTokens)
          .set({ revokedAt: new Date() })
          .where(eq(mcpTokens.userId, userId));
      });

      const getActiveForUser = Effect.fn("db/getActiveMcpTokenForUser")(function* (userId: UserId) {
        const results = yield* db
          .select()
          .from(mcpTokens)
          .where(and(eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)));
        return Option.fromIterable(results);
      });

      const findActiveOwnerByHash = Effect.fn("db/findActiveMcpTokenOwnerByHash")(function* (
        tokenHash: string,
      ) {
        const tokenRows = yield* db
          .select()
          .from(mcpTokens)
          .where(and(eq(mcpTokens.tokenHash, tokenHash), isNull(mcpTokens.revokedAt)));
        const tokenRow = tokenRows[0];
        if (tokenRow === undefined) return Option.none<ActiveTokenOwner>();

        const userRows = yield* db.select().from(users).where(eq(users.id, tokenRow.userId));
        const userRow = userRows[0];
        if (userRow === undefined) return Option.none<ActiveTokenOwner>();

        return Option.some<ActiveTokenOwner>({
          userId: tokenRow.userId as UserId,
          email: userRow.email,
          name: userRow.name,
        });
      });

      return {
        upsertForUser,
        revokeForUser,
        getActiveForUser,
        findActiveOwnerByHash,
      };
    }),
  );
}
