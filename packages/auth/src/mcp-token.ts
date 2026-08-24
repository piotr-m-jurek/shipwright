/**
 * Generation/hashing for the SHIP-115 Step 6 MCP token — a credential
 * separate from the better-auth `session_token` cookie.
 *
 * `session_token` is HttpOnly and authenticates every apps/api endpoint the
 * browser can reach; exposing it via a JSON response (the original SHIP-115
 * draft) would put a full-account-privilege credential outside HttpOnly
 * protection. This token is purpose-scoped to MCP access only and is
 * independently revocable without touching the browser session.
 *
 * The raw value is shown to the user exactly once, at generation time (see
 * apps/api's mcp-token handler). Only its SHA-256 hash is ever persisted
 * (`mcp_tokens.tokenHash`) — same practice as password/API-key storage.
 * SHA-256 (not bcrypt/argon2) is correct here: the token itself is a
 * high-entropy random value, not a low-entropy user-chosen password, so a
 * fast, unsalted cryptographic hash is sufficient and keeps every-request
 * lookups (apps/mcp/src/auth.ts) cheap.
 */
import { randomBytes, createHash } from "node:crypto";
import { Effect } from "effect";

const TOKEN_BYTE_LENGTH = 32;

/** Generates a new raw MCP token. Uses a CSPRNG (`node:crypto`), not Effect's `Random` module, which is not guaranteed cryptographically secure. */
export const generateMcpToken = Effect.sync(() => randomBytes(TOKEN_BYTE_LENGTH).toString("hex"));

/** Deterministic — same raw token always hashes to the same value, which is what makes lookup-by-hash possible. */
export const hashMcpToken = (rawToken: string): string =>
  createHash("sha256").update(rawToken).digest("hex");
