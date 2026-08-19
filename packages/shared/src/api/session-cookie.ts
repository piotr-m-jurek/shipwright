/**
 * Single source of truth for the better-auth session cookie name and the
 * two operations every consumer of it needs: build the cookie header to
 * pass to auth.api.getSession(), and extract the token from a raw cookie
 * header string.
 *
 * Used by apps/api (HttpApiSecurity, SSE handlers, HttpApi middleware) and
 * apps/mcp (Bearer-to-cookie translation for MCP clients). Lives here (not
 * @shipwright/auth) because it has zero runtime dependencies and
 * packages/shared is safe to import from apps/web — the cookie *name* is a
 * frontend-relevant fact too (it is what better-auth's client SDK sets).
 */

import { Option, Redacted } from "effect";

export const SESSION_COOKIE_NAME = "better-auth.session_token";

/** Builds the `Headers` object to pass to `auth.api.getSession({ headers })`. */
export const sessionCookieHeader = (token: Redacted.Redacted<string>): Headers =>
  new Headers({ cookie: `${SESSION_COOKIE_NAME}=${Redacted.value(token)}` });

/** Extracts the session token from a raw `Cookie` header value, or `null` if absent. */
export const extractSessionToken = (
  cookieHeader: string | null | undefined,
): Option.Option<Redacted.Redacted<string>> => {
  if (!cookieHeader) return Option.none();

  const prefix = `${SESSION_COOKIE_NAME}=`;
  const token = cookieHeader
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(prefix))
    ?.slice(prefix.length);

  return Option.fromNullishOr(token).pipe(Option.map(Redacted.make));
};
