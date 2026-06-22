# Build Progress Log

> Running log of completed phases, decisions made, and issues encountered.
> **Read this before starting a new session.**

---

## Quick-start for new sessions

**What this is:** AI agent — ingests messy project docs → asks clarifying questions → produces Project Brief + Implementation PRD.

**Stack:**
- Effect HttpApi server (port 3000)
- Vite SPA (port 5173, proxies `/api` → port 3000)
- Drizzle + pgvector on Postgres (port 5433)
- rustfs S3-compatible storage (port 9000)
- Vercel AI SDK + Claude 3.7 Sonnet
- Effect v4 beta (`4.0.0-beta.78`)
- XState (used from Phase 4 onwards)

**Commands:**
```
docker compose up -d        start Postgres + rustfs
pnpm dev                    start Effect server + Vite (two processes via concurrently)
pnpm test                   unit tests
pnpm test:corpus            integration test against 5-doc corpus (needs ANTHROPIC_API_KEY)
pnpm db:push                apply schema changes (new enums: use psql directly — drizzle-kit requires TTY)
```

**Effect docs:** `docs/effect-smol/ai-docs/src/` — authoritative reference for all Effect v4 patterns.

**Coding conventions:**
| What | Pattern |
|---|---|
| Effect errors | `Schema.TaggedErrorClass`, tag: `"shipwright/module/ErrorName"` |
| Effect services | `Context.Service` + static `layer` |
| Effect functions | `Effect.fn("span/name")(generator, ...combinators)` |
| Zod schemas | agent layer only — `Output.object({ schema })` for LLM structured output |
| Effect schemas | HTTP layer — `Schema.Class` in `src/shared/schemas/api.ts` |
| Route handlers | `HttpApiBuilder.group` Effect generators — no Promise bridges |
| LLM message format | documents as `messages` user content with `=== filename ===` headers, not in system prompt |
| Schema changes with new enums | apply via `psql` directly, then update `src/db/schema.ts` |

**Architecture deviations from original plan:**
- **API layer:** Effect HttpApi (`effect/unstable/httpapi`) instead of Hono + Hono RPC. The entire backend is Effect — no bridge layer needed. See `docs/stack.md` §2.
- **DB layer:** migrating to Effect `DatabaseService` incrementally (storage done, queries next). Phase 9 "Full Effect Rewrite" is an ongoing migration, not a single phase.
- **Folder:** `src/api/` does not exist — server is in `src/server/`.
- **`summarizing` state deferred (Phase 4):** The `tokensBelowThreshold` guard correctly needs `documentSummaries[]` populated before it fires, which requires a `summarizing` state between `uploading` and `processing`, with `SUMMARIZATION_DONE` fired after all summaries are stored. V1 implementation runs summarization inside the analysis pipeline after `USER_CONFIRM`, so the guard always sees empty `documentSummaries[]` and defaults to `context` mode. Acceptable for V1 corpus sizes. Correct fix documented in `build_sequence.md` Phase 4 and tracked in `acceptance_criteria.md` Phase 4 as a known deviation.

**Build sequence:** Phases 1–8 → Phase 9 (Effect migration, ongoing) → Phase 10 (React SPA)

**Current status:** Phase 3 COMPLETE · Phase 4 COMPLETE (gate passed 17.06.2026) · Phase 5 next

---

## Phase 0 — Scaffold (COMPLETE)

**Gate passed.**

### What was built

- Single `package.json` monolith (no monorepo)
- Folder structure: `src/server/`, `src/agent/`, `src/db/`, `src/storage/`, `src/shared/`, `src/web/`
- Effect HttpApi server in `src/server/server.ts` (replaced original Hono setup — see Architecture Decision below)
- React frontend in `src/web/` with `@vitejs/plugin-react`
- Full Drizzle schema in `src/db/schema.ts` — all tables, all columns, relations wired
- `StorageAdapter` as Effect `Context.Service` in `src/storage/`
- Docker Compose: `pgvector/pgvector:pg17` on port 5433, `rustfs/rustfs` on port 9000
- `docker/init.sql` — auto-enables pgvector extension on first container start
- `src/config.ts` — typed config with `envOrThrow`
- `.env.example` with all required variables documented

### Key decisions

- **Port 5433** for Postgres — avoids collision with local Postgres on 5432
- **rustfs** over garage — simpler setup, no init ceremony
- **`@aws-sdk/client-s3`** for storage — provider portability, not Bun's built-in S3 client
- **drizzle-orm v1.0.0-beta** — uses `defineRelations` (new v1 beta API, not old `relations` helper)
- **TypeScript 5.8** — React 19 types not compatible with TS 6 pre-release

---

## Phase 1 — Document Ingestion (COMPLETE)

**Gate passed (structural wiring). Embedding items pending OpenAI quota top-up — see note below.**

### What was built

- `src/agent/parsers.ts` — PDF (`unpdf`), DOCX (`mammoth.extractRawText()`), Markdown, plain text
- `src/agent/chunker.ts` — recursive character splitter with overlap; `estimateTokenCount` via `js-tiktoken`; `LocationMeta` jsonb per chunk (`pageNumber`, `headingPath`, `charOffset`)
- `src/agent/chunker.test.ts` — 30 tests, all passing
- `src/agent/embedder.ts` — `embedChunks` via Vercel AI SDK `embedMany` + OpenAI `text-embedding-3-small`
- `src/agent/estimate-token-count.ts` — module-level tiktoken encoder singleton (avoids WASM reload on each call)
- `src/db/queries.ts` — `createAgentSession`, `updateAgentSession`, `createDocument`, `updateDocumentTokenCount`, `createChunks`, `getDocumentById`
- `src/storage/index.ts` — `StorageAdapter` Effect service (6 operations, all with typed errors)
- `POST /api/sessions/upload-url` — validates body, creates session + document records, returns presigned URLs
- `POST /api/sessions/:id/confirm-upload` — `headObject` verification, fires processing pipeline, returns `202`
- `src/agent/process-uploaded-documents.ts` — parse → chunk → embed → store pipeline, `p-queue` concurrency: 2
- `src/shared/schemas/` — `ChunkMetaSchema`, `UploadRequestSchema`, `DocumentTypeSchema`

### Key decisions

- **Presigned upload** — files go client → S3 directly; server generates URL, verifies via `HeadObject`, never touches file bytes
- **Multiple files per session** — `POST /api/sessions/upload-url` accepts an array of file metadata objects
- **No `sourceDocument` column on chunks** — derived via `documentId → documents.filename` JOIN; join cost acceptable at this scale
- **`agentSessions`** table name (not `sessions`) — avoids collision with the future Better Auth sessions table
- **`p-queue` concurrency: 2** — in-process queue prevents memory exhaustion from concurrent parse + embed; durable queue (`pg-boss`) deferred to fine-tuning phase
- **Polling for status (V1)** — client polls `GET /api/sessions/:id`; fire-and-forget processing updates status; SSE upgrade deferred to Phase 10
- **`ts-pattern`** — adopted for exhaustive pattern matching in parsers and chunker
- **Hexagonal architecture** — route handlers are thin adapters; business logic in `src/agent/`; route handler owns 400s, use case owns 500s
- **Better Auth deferred** — drizzle-orm v1 beta compatibility risk; auth added when drizzle hits stable 1.0
- **Image support deferred** — not in spec; added complexity without auth scope

### Outstanding known issues (to fix in Phase 4)

- `src/agent/parsers.ts` — uses `fileTypeFromBuffer` instead of `fileTypeFromStream` (Rule 12 violation). Fix: connect to `downloadPartialObject` for first-N-bytes content verification.
- `src/agent/chunker.ts` — no minimum chunk size guard yet (build sequence requirement).
- `src/server/server.ts` — broken relative import paths (`./db/`, `./storage/`, `./shared/` don't resolve from `src/server/`). Fix when wiring Phase 4 routes.
- `src/shared/schemas/api.ts` — `PostAgentSessionAnswersRequest.answers` is `string[]` not `{questionId, text}[]`. Fix in Phase 4.

### OpenAI quota note

OpenAI key is present and correctly configured. Embeddings blocked by quota exhaustion at time of Phase 1 completion. Parse → chunk pipeline confirmed working. Items requiring real embeddings (semantic search verification) to be re-verified once quota is topped up. This did not block Phase 3 — the summarizer reads existing chunks from DB.

---

## Phase 2 — XState Machine Design (COMPLETE)

**Gate passed.**

Diagram stored in `README.md`. Approved after gate review.

### Machine shape

**States:** `idle` → `uploading` → `processing` → `analyzing` → `awaiting_answers` → `re_evaluating` → `generating` → `complete` → `revising` + `error`

**Events:** `UPLOAD_COMPLETE`, `ANALYSIS_DONE`, `USER_ANSWERED`, `ANSWERS_SUFFICIENT`, `ANSWERS_INSUFFICIENT`, `OUTPUT_READY`, `ERROR`, `USER_CONFIRM`, `REVISION_REQUESTED`

**Guards:** `hasEnoughContext`, `tokensBelowThreshold` (evaluates summary token counts, not raw document token counts), `roundLimitReached`

**Context shape** defined as `MachineContextSchema` in `src/shared/schemas/machine.ts`. Used as both the TypeScript type and the validation schema for `xstateSnapshot` rehydration from Postgres.

### Key decisions

- **`USER_CONFIRM` added** — explicit user confirmation required before analysis starts; machine does not auto-transition from `processing` to `analyzing`
- **`awaiting_answers` has no ERROR transition in V1** — session blocks until user responds; server restart handled via snapshot rehydration
- **`revising` state added** — `complete → revising` on `REVISION_REQUESTED`; may loop through `awaiting_answers` if new questions surface; each pass through `generating` increments `outputVersion`

---

## Effect-TS Migration (between Phase 2 and Phase 4)

### What was built

**`src/storage/index.ts` — `StorageAdapter` Effect `Context.Service` (COMPLETE)**

All six operations with typed errors:

| Method | Error type |
|---|---|
| `upload` | `UploadError` |
| `download` | `DownloadError` |
| `downloadPartialObject` | `DownloadError` |
| `remove` | `DeleteError` |
| `generatePresignedUrl` | `PresignedUrlError` |
| `headObject` | `HeadObjectError` |

Key patterns used:
- `Layer.effect` + `Effect.gen` — `S3Client` constructed once, closed over by all methods
- `Effect.fn("span/name")(generator, ...combinators)` — generator for core logic, combinators for error mapping
- `Effect.tryPromise({ try, catch })` — wraps AWS SDK calls with typed errors
- `Effect.catchDefect` — intercepts untyped AWS exceptions in `headObject`, maps 403/404 to `false`

### XState + Effect bridge pattern

XState actors call `Effect.runPromise(effect.pipe(Effect.provide(runtime)))` inside `invoke.src`. XState owns all state transitions. Effect owns typed errors and DI inside each actor.

### Full rewrite planned (Phase 9)

See `docs/build_sequence.md` Phase 9. Key remaining items:
- `DatabaseService` — wrap all Drizzle queries as an Effect service; enables mock DB in tests
- `@effect/ai-anthropic` — replace Vercel AI SDK with Effect's typed AI layer
- Parsers + embedder as Effect services
- Delete legacy `S3Storage` Promise class
- Merge all layers in `runtime.ts`

---

## Phase 3 — Per-Document Summarization + Challenger (COMPLETE — 15.06.2026)

**Gate passed. All 5 planted issues surfaced. `pnpm test:corpus` confirms on 15.06.2026.**

### Design (revised 11.06.2026)

The original single-pass Extractor was replaced by a per-document map-reduce summarizer. The core change: **no analysis pass reads `documents.rawText` directly**. Every LLM call works from chunks loaded from the `chunks` table.

**Pipeline:**
1. Load chunks from `chunks` table by `documentId`, ordered by `chunkIndex`
2. Map pass — batch chunks (default: 20/batch), each batch → intermediate summary row (`summary_type = 'map_intermediate'`)
3. Reduce pass — reduce intermediates → one final summary row (`summary_type = 'final'`) per document
4. Challenger pass — loads all `final` summaries via JOIN, compares across documents for conflicts, gaps, ambiguities

**Why summaries not raw text for the Challenger:** Summaries are compact enough to fit all documents in a single context window. The Challenger reasons across the synthesised content, not raw chunks.

### What was built

- `document_summaries` table — `map_intermediate` and `final` rows, versioned (re-summarisation creates new rows, never overwrites)
- `summary_items` table — normalised requirements/constraints/assumptions; one row per item; `confidence_level` and `summary_item_type` enums
- `src/shared/schemas/agent.ts` — `DocumentSummarySchema`, `ItemWithSourceSchema`, `GapReportSchema`, `ConflictSchema`
- `src/agent/summarizer.ts` — rolling reduce pattern; `persistSummary` helper; `MapReduceSystemPrompt`; version increment on re-run via `getCurrentDocumenSummaryVersion`
- `src/agent/challenger.ts` — rewritten to accept `ReconstructedSummary[]` (not raw text); updated system prompt
- `src/db/queries.ts` — `createSummaryItems`, `getFinalSummariesBySession` (two-query approach: summaries then items, grouped in TypeScript), `getChunksByDocumentId`
- `src/agent/test-corpus.ts` — full DB pipeline: session + docs + chunks inserted, `summarizeAllDocuments` called, finals loaded, passed to `runChallenger`

### Key decisions

- **`document_summaries` as a separate table** (not a column on `documents`) — stores the full map-reduce tree for debugging and evals; versioned; keeps `documents` rows narrow
- **Summarization strategy left swappable** — interface in `summarizer.ts` supports map-reduce (default), hierarchical, and agentic-with-tools. Benchmarking deferred.
- **Two-query pattern for `getFinalSummariesBySession`** — `DISTINCT ON` + `leftJoin` collapsed arrays to 0–1 items (bug). Fixed by separate queries + TypeScript grouping.
- **Architecture Rule 13 added** — analysis passes must not read `documents.rawText`

### Gate verification — 15.06.2026

```
pnpm test:corpus

✓ 5 final summaries in document_summaries (one per document)
✓ All have non-null sourceDocument
✓ Issue 1: mobile scope conflict (prd_draft vs transcript)
✓ Issue 2: EU data residency surfaced from rfp.md
✓ Issue 3: delegation acceptance criteria gap (prd_draft vs hr_requirements.pdf)
✓ Issue 4: notification channel ambiguity
✓ Issue 5: SSO/auth conflict (prd_draft vs hr_requirements.pdf)
Planted issues surfaced: 5/5
```

---

## Architecture Decision — Target Stack (16.06.2026)

Agreed target architecture for the full-stack setup.

### Backend

- **Effect `HttpApiBuilder`** replaces Hono entirely. No Hono in the final stack.
- **Better Auth** handles sessions + OAuth (GitHub/Google). Mounted as a fetch passthrough at `/api/auth/*` — `auth.handler` is `(Request) => Promise<Response>`, drops into `HttpRouter` catch-all with no adapter needed.
- **Auth middleware** via `HttpApiMiddleware` — injects typed `CurrentUser` into handler context; handlers that require auth won't compile without it.
- **`HttpApi` schema** (`src/api/schema.ts`) — shared module with zero server imports; imported by both server (to register handlers) and frontend (to generate typed client); schema changes propagate end-to-end at compile time.
- **Drizzle** stays. Better Auth gets its own DB connection via `drizzleAdapter`, sharing the same Postgres pool.

### Frontend

- **Vite frontend-only** — no `@hono/vite-dev-server`, no API handling in Vite
- **`@effect/atom-react`** (`4.0.0-beta.83`) for state — atoms backed by `HttpApiClient` calls; replaces React Query + Zustand. Risk: still beta; fallback is plain `useState`/`useEffect` with `HttpApiClient`.
- **`HttpApiClient.make(Api)`** generates a typed client from the shared `HttpApi` definition — no OpenAPI codegen step

### Dev setup

```
make dev
  ├── docker compose up -d        (postgres + rustfs)
  ├── tsx --watch src/server.ts   (Effect API, port 3000)
  └── vite                        (frontend only, port 5173, proxies /api → 3000)
```

`concurrently` handles the two-process dev target. `vite.config.ts` has:
```ts
server: { proxy: { "/api": "http://localhost:3000" } },
preview: { proxy: { "/api": "http://localhost:3000" } },
```

### Production

Single `node src/server.js`. Effect server serves API + `dist/` static files via `HttpServerResponse.file` + SPA fallback. No nginx required.

### What this replaces

| Removed | Kept |
|---|---|
| `@hono/vite-dev-server` plugin | Drizzle, Effect agent logic, XState |
| Hono from `src/api/index.ts` and `src/index.ts` | All DB schema |
| `ManagedRuntime` bridge in `src/runtime.ts` | `src/server.ts` as canonical entry point |

### Open questions

1. `@effect/atom-react` beta risk — decide at Phase 10 whether to commit or fall back to plain hooks
2. Better Auth + Drizzle v1 beta — re-evaluate when drizzle hits stable 1.0

---

## Codebase audit cleanup — 17.06.2026

Full audit of `src/` vs docs completed.

### Code fixes applied

- **`src/agent/extractor.ts` deleted** — dead code; violated Rule 13 (raw text to LLM); had missing imports
- **`src/db/queries.ts` — `reconstructSummaries` bug fixed** — `DISTINCT ON` + `leftJoin` collapsed arrays to 0–1 items; fixed with two-query approach + TypeScript grouping
- **`src/shared/schemas/agent.ts`** — `ClarifyingQuestionsSchema` and `ClarifyingQuestionSchema` exported (required by Phase 4)
- **`src/shared/schemas/machine.ts`** — stale import from `db/out/schema.ts` replaced with `db/schema.ts` directly
- **`src/storage/index.ts`** — `"shipwreck/..."` typo fixed to `"shipwright/..."` in all error tags and service identifier; dead `yield* Effect.void` stub removed
- **`src/agent/errors.ts`** — error tags now follow `"shipwright/module/ErrorName"` convention
- **`src/agent/estimate-token-count.ts`** — encoder moved to module-level singleton (was re-instantiating + loading WASM on every call)

### Docs updated

- `docs/stack.md` — API layer updated from Hono to Effect HttpApi; DB layer updated; Final Stack Summary updated
- `docs/architecture_rules.md` — Rules 6, 7, 8, 10 updated for Effect HttpApi and AI SDK v6 (`Output.object()`)
- `docs/build_sequence.md` — Phase 0 structure updated to actual layout; Phase 6 updated from Hono to Effect HttpApi wiring
