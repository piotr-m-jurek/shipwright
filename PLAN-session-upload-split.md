# Unify session-creation and document-upload (SHIP-179/180/181 redesign)

## Context

`sessionUploadUrl` (always creates a new session) and `addDocumentUploadUrl` (SHIP-180, always targets an existing `complete` session) duplicate the same underlying work — creating document rows and presigned upload URLs. Goal: share that work completely, without merging session-creation into a single "get-or-create" endpoint. Per review feedback, the session is still created **server-side** (not a client-generated ID) — so `sessionUploadUrl` stays as the entry point for a brand-new session, and `addDocumentUploadUrl` stays the entry point for an existing one. What's shared between them is the actual document/upload-URL creation step, which was already extracted this session (`createDocumentUploads` in `create-upload-session.ts`) and needs no further change.

## Design

### 1. Session creation stays a small, named usecase — not merged into upload

`sessionUploadUrl`'s pipeline keeps creating the session server-side (`agentSessionDb.createAgentSession({ status: "idle", userId })`, ID via the DB's `defaultRandom()`, unchanged from today). Per the earlier ask for a proper domain usecase (room for a future title-on-creation feature), extract just the session-row-creation step into its own small function — e.g. `createSession(userId): Effect<AgentSession, ...>` in `create-upload-session.ts` — rather than leaving it inlined in `createUploadSession`. `createUploadSession` itself stays as the thin orchestrator: `createSession(userId)` → `createDocumentUploads(session.id, files)`.

No client-generated IDs, no `onConflictDoNothing`/race handling — dropped from the earlier draft, it was only needed for the get-or-create shape.

### 2. `addDocumentUploadUrl`'s precondition — widened, clearly named

`requireCompleteForDocumentAddition` (SHIP-180, `AgentSessionAggregate`) is renamed to **`requireSessionAcceptsDocuments`**. Behavior: valid from `idle`, `uploading` (+ sub-states), or `complete`; still rejects the busy pipeline states (`analyzing`, `awaiting_answers`, `re_evaluating`, `generating`, `revising`) with `SessionStateError`, same as `requireCompleteForDocumentAddition` does today for the `complete`-only case.

Concurrent uploads during the busy states (parallel XState regions) are explicitly **out of scope for this plan** — sequenced as a separate follow-up plan once this lands (see below).

### 3. What's actually shared

Only `createDocumentUploads(sessionId, files)` (already built, already shared) — the per-file "create document row + presigned URL" loop. `sessionUploadUrl` calls it after creating a session; `addDocumentUploadUrl` calls it after verifying an existing one. No new merged pipeline function, no renamed `uploadDocuments` — that name is dropped along with the merge idea it described.

### 4. API surface — unchanged from the review-approved version

Both `sessionUploadUrl` and `addDocumentUploadUrl` stay as separate endpoints (this part was explicitly approved). `confirmUpload` untouched, already shared for both flows since SHIP-180.

### 5. Tests — minimal

Just precondition-boundary coverage for the renamed/widened check (accepts idle/uploading/complete, rejects one busy state as a representative case) — not an exhaustive matrix. No new tests needed for session creation itself, since `createSession`'s extraction doesn't change its behavior.

## Follow-up (tracked separately)

Concurrent upload/chunking during `analyzing`/`generating`/`revising` (parallel XState regions) is filed as [SHIP-186](https://linear.app/shipwright-ai/issue/SHIP-186) — sequenced after this plan ships, own design pass.

## Verification

- `cd apps/api && bun run typecheck` clean.
- `bun --env-file=.env run test` — baseline (58 passed / 12 pre-existing unrelated failures) plus the small precondition test addition.
- No DB migration needed either way.
