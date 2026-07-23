# Phase 12 — Auth: Better Auth

> Working reference for implementation. Delete after gate passes and docs are updated.

---

## Architecture

- `CurrentUser` + `Authorization` middleware tag live in `packages/shared/src/api/middleware.ts`
- Server implementation (`AuthorizationLayer`) lives in `apps/api/src/server/authorization.ts`
- Better Auth has its own plain Drizzle connection (`apps/api/src/auth/db.ts`) — outside Effect boundary
- Frontend client middleware lives in `apps/web/src/lib/auth-client.ts`

---

## Steps

### Step 1 — Auth DB connection

**File:** `apps/api/src/auth/db.ts`

Plain `drizzle-orm/node-postgres` instance. Reads `DATABASE_URL` from `process.env` directly.
`pg` already in deps. No ConfigService, no Effect — Better Auth runs outside the Effect runtime.

### Step 2 — Auth config

**File:** `apps/api/src/auth/auth.ts`

```ts
betterAuth({
  database: drizzleAdapter(authDb, { provider: "pg", usePlural: true }),
  socialProviders: {
    github: { clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! },
    google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
  },
})
```

`BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` read automatically by convention from `process.env`.

### Step 3 — CLI generate + schema merge

From `apps/api/`:
```bash
npx auth@latest generate --config src/auth/auth.ts
```

CLI generates `users`, `sessions`, `accounts`, `verifications` table definitions.
Merge into `schema.ts`. Also add:
```ts
// on agentSessions:
userId: text("user_id").notNull().references(() => users.id)
```
Add `users` to `defineRelations`. Run `db:push`.

### Step 4 — Mount auth handler

In `apps/api/src/server/server.ts`, wire `auth.handler` before `HttpApiBuilder`:

```ts
HttpRouter.all("/api/auth/*", (req) =>
  Effect.promise(() => auth.handler(req.source))
)
```

### Step 5 — `CurrentUser` + `Authorization` middleware tag (shared)

**File:** `packages/shared/src/api/middleware.ts`

```ts
export class CurrentUser extends Context.Service<CurrentUser, {
  id: string; email: string; name: string
}>()("shipwright/auth/CurrentUser") {}

export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "shipwright/auth/Unauthorized", { message: Schema.String }, { httpApiStatus: 401 }
) {}

// Declares what the middleware provides, not how — server impl is in apps/api
export class Authorization extends HttpApiMiddleware.Service<Authorization, {
  provides: CurrentUser
}>()("shipwright/auth/Authorization", {
  requiredForClient: true,
  security: {
    cookie: HttpApiSecurity.apiKey({ in: "cookie", name: "better-auth.session_token" })
  },
  error: Unauthorized
}) {}
```

Add `./middleware` export path to `packages/shared/package.json` exports.

### Step 6 — Protect routes + split groups

In `packages/shared/src/api/api.ts`, split `SystemApiGroup` into two:

- `PublicApiGroup` — `health` only, no middleware
- `SystemApiGroup` — all session endpoints, `.middleware(Authorization)`

Both added to `Api`.

### Step 7 — Server middleware implementation

**File:** `apps/api/src/server/authorization.ts`

```ts
export const AuthorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function*() {
    return Authorization.of({
      cookie: Effect.fn(function*(httpEffect, { credential }) {
        const session = yield* Effect.promise(() =>
          auth.api.getSession({
            headers: new Headers({ cookie: `better-auth.session_token=${Redacted.value(credential)}` })
          })
        )
        if (!session) return yield* new Unauthorized({ message: "Invalid or missing session" })
        return yield* Effect.provideService(httpEffect, CurrentUser, {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
        })
      })
    })
  })
)
```

Add `AuthorizationLayer` to `ServiceLayer` in `server.ts`.

### Step 8 — Row-level isolation

In `apps/api/src/db/queries.ts`:
- Every method touching `agent_sessions`, `documents`, `chunks`, `outputs` gains `userId: string`
- Add `AND user_id = $userId` to each query

In `apps/api/src/server/handlers.ts`:
- Every handler that touches session data: `const user = yield* CurrentUser`
- Pass `user.id` as `userId` to DB methods
- `getAgentSesionById` → filter by `userId` (returns 404 not 403 on mismatch — do not leak existence)

### Step 9 — `.env.example`

Add to repo root `.env.example`:
```
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
BETTER_AUTH_SECRET=   # openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:3000
```

### Step 10 — Frontend auth

**Files:**
- `apps/web/src/lib/auth-client.ts` — `createAuthClient` from `better-auth/react`
- `apps/web/src/store/api.ts` — wire `Authorization` client middleware via
  `HttpApiMiddleware.layerClient(Authorization, ...)` — reads cookie automatically
- `apps/web/src/routes/login.tsx` — GitHub + Google sign-in buttons
- `apps/web/src/routes/__root.tsx` — redirect unauthenticated users to `/login`
- Header logout button

---

## Cookie name

Better Auth default session cookie name: `better-auth.session_token`
Verify in DevTools after first sign-in. If different, update `HttpApiSecurity.apiKey` name in Step 5.

---

## Gate

```
- Authenticated user completes full E2E: upload → confirm → answer → output → download
- Unauthenticated request to any /api/sessions/* → 401
- User A creates session S; User B calls GET /api/sessions/S → 404 (not 403)
- GET /health → 200 with no auth required
- pnpm --filter @shipwright/api test:phase4 still passes (note: will need userId in test setup)
```

---

## Notes

- `HttpApiSecurity.apiKey({ in: "cookie", name: "..." })` — Effect extracts cookie value automatically
- The server implementation uses `auth.api.getSession` from Better Auth — this is a server-side call,
  not a fetch. It reads directly from the DB via Better Auth's internal adapter.
- Row-level isolation: return 404 (not 403) when userId doesn't match — do not reveal session existence
- `usePlural: true` in drizzleAdapter — our tables are all plural (`agentSessions`, `documents`, etc.)
