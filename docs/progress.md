# Build Progress Log

> Running log of completed phases, decisions made, and issues encountered.
> Read this before starting a new session.

---

## Quick-start for new sessions

**Project:** AI agent that ingests messy project docs → asks clarifying questions → produces Project Brief + Implementation PRD.

**Stack:** Effect HttpApi server (port 3000) · Vite SPA (port 5173) · Drizzle + pgvector (port 5433) · rustfs S3 (port 9000) · Vercel AI SDK + Claude · Effect v4 beta · XState (Phase 4+)

**Run:** `docker compose up -d && pnpm dev`
**Tests:** `pnpm test` · `pnpm test:corpus` (needs real ANTHROPIC_API_KEY)
**Schema:** `pnpm db:push` (or direct psql for new enum additions — drizzle-kit requires TTY)
**Effect docs:** `docs/effect-smol/ai-docs/src/` — authoritative reference for Effect patterns

**Key conventions:**

- Effect errors: `Schema.TaggedErrorClass`, tag format `"shipwright/module/ErrorName"`
- Effect services: `Context.Service` + static `layer`
- Effect functions: `Effect.fn("span/name")(generator, ...combinators)`
- Zod schemas: agent layer only — `Output.object({ schema })` for LLM structured output
- Effect schemas: HTTP layer — `Schema.Class` definitions in `src/shared/schemas/api.ts`
- Route handlers: `HttpApiBuilder.group` Effect generators — no Promise bridges
- Documents go into `messages` user content with `=== filename ===` headers, not system prompt
- Schema changes requiring new enums: apply via psql directly, then update `src/db/schema.ts`

**Architecture deviation from original plan:**
- **API layer**: Effect HttpApi (`effect/unstable/httpapi`) instead of Hono + Hono RPC.
  Reason: entire backend is Effect — no bridge layer needed. See `docs/stack.md` §2.
- **DB layer**: migrating to Effect `DatabaseService` incrementally (storage done, queries next).
  Phase 9 "Full Effect Rewrite" is now an ongoing migration, not a single phase.
- **`src/api/` folder**: does not exist — server is in `src/server/`.

**Build sequence:** Phases 1–8 → Phase 9 (Effect DB migration, ongoing) → Phase 10 (React SPA)

**Current status:** Phase 3 COMPLETE (gate passed 15.06.2026) · Phase 4 next

---

## Phase 0 — Scaffold (COMPLETE)

### What was built

- Single `package.json` monolith (no monorepo)
- Folder structure: `src/api/`, `src/agent/`, `src/db/`, `src/storage/`, `src/shared/`, `src/web/`
- Hono API server embedded in Vite dev server via `@hono/vite-dev-server` (single port: 5173)
- React frontend in `src/web/` with `@vitejs/plugin-react`
- Full Drizzle schema in `src/db/schema.ts` — all 7 tables, all columns, relations wired
- `StorageAdapter` interface + `S3Storage` implementation using `@aws-sdk/client-s3`
- Docker Compose: `pgvector/pgvector:pg17` on port 5433 + `rustfs/rustfs` on port 9000
- `docker/init.sql` auto-enables pgvector extension on first container start
- `src/config.ts` — typed config with `envOrThrow`, covers DB and storage
- `.env.example` with all required variables documented
- Hono route stubs in `src/api/index.ts` (all 5 routes from the spec)

### Key decisions

- **Single Vite dev server** (not two separate servers) — Hono embedded via `@hono/vite-dev-server`
- **Port 5433** for Postgres — local Postgres was already running on 5432
- **rustfs** chosen over garage — simpler setup, no init ceremony
- **`@aws-sdk/client-s3`** for storage — not Bun's built-in S3 client (Rule 4 compliance, provider portability)
- **drizzle-orm v1.0.0-beta** — using `defineRelations` (new v1 beta API, not old `relations` helper)
- **TypeScript 5.8** — not 6.x (React 19 types not compatible with TS 6 pre-release)

### Deviations from build sequence

- `src/web/` used instead of `src/client/` — functionally equivalent, matches build sequence intent

### Architecture rules status

All 10 rules checked — no violations at Phase 0.

### Gate verification

- `drizzle-kit push` succeeds
- `SELECT * FROM sessions LIMIT 1` returns empty result
- `SELECT extname FROM pg_extension WHERE extname = 'vector'` returns a row
- S3 upload and download via `@aws-sdk/client-s3` against rustfs succeeds

---

## Phase 1 — Document Ingestion (IN PROGRESS)

### Done

- `src/agent/parsers.ts` — PDF (`unpdf`), DOCX (`mammoth.extractRawText()`), Markdown, plain text
- `src/agent/chunker.ts` — recursive character splitter, overlap, config per file type, `estimateTokenCount` via `js-tiktoken`
- `src/agent/chunker.test.ts` — 14 tests, all passing
- `src/agent/embedder.ts` — `embedChunks` via Vercel AI SDK `embedMany` + OpenAI `text-embedding-3-small`
- `src/shared/schemas/index.ts` — insert/select schemas derived from Drizzle via `drizzle-zod`, `ChunkMetaSchema`, `UploadRequestSchema`

### Done (continued)

- `src/db/queries.ts` — `createAgentSession`, `updateAgentSession`, `createDocument`, `updateDocumentTokenCount`, `createChunks`
- `src/storage/index.ts` — `generatePresignedPutUrl` and `headObject` added to `S3Storage`
- `POST /api/sessions/upload-url` — validates JSON body, creates session + document records, returns presigned URLs
- `POST /api/sessions/:id/confirm-upload` — `headObject` verification, returns `202`

### Still to build

1. **Fix compile blockers** — remove `../../db/out/schema.js` import from `src/shared/schemas/index.ts`; remove duplicate `estimateTokenCount` from `chunker.ts`
2. **Add `getDocumentById` to `src/db/queries.ts`**
3. **Implement `src/agent/process-uploaded-documents.ts`** — sequential `for...of` processing with `p-queue` (concurrency: 2) for memory protection; on success: `updateAgentSession('processing')`; on error: `updateAgentSession('error')`
4. **Hexagonal cleanup of `POST /api/sessions/upload-url`** — extract business logic to `src/agent/createUploadSession.ts`; route handler becomes thin adapter
5. **Apply mentor notes** — `parsers.ts`: swap regex for `path.extname()`; `chunker.ts`: minimum chunk size guard
6. **`drizzle-kit push`** if schema changed
7. **Phase 1 gate verification**

### Key decisions

- **Better Auth withdrawn** — drizzle-orm v1 beta + Better Auth compatibility risk. Auth deferred until drizzle reaches stable 1.0.
- **Presigned upload adopted** — files go directly from client to S3, not through Hono. Backend generates presigned URL, client PUTs directly, backend confirms and processes.
- **No `sourceDocument` column on chunks** — derived via `documentId` JOIN to `documents.filename`. Simpler schema, join cost acceptable at this scale.
- **`agentSessions`** — renamed from `sessions` to avoid collision with future Better Auth session table.
- **Image support deferred** — not in original spec, added complexity without auth scope.
- **Multiple files per session** — `POST /api/sessions/upload-url` accepts an array of file metadata objects.
- **Hexagonal architecture for processing** — route handlers are thin adapters (validation + HTTP), business logic lives in use case functions (`src/agent/`). Route handler owns 400s, use case owns 500s and session state updates.
- **`p-queue` for concurrency control** — in-process queue with `concurrency: 2` wrapping document processing in `process-uploaded-documents.ts`. Prevents memory exhaustion from concurrent parse + embed operations. Persistent queue (pg-boss/BullMQ) deferred to fine-tuning phase.
- **Polling for status updates (V1)** — client polls `GET /api/sessions/:id` to track session status after `confirm-upload` returns `202`. Fire-and-forget processing updates `agentSessions.status` when done.

### Future consideration

- **Replace polling with SSE or WebSocket** — `GET /api/sessions/:id` polling works for V1 but adds unnecessary request overhead. When the React SPA is built (Phase 9), consider replacing with Server-Sent Events via `POST /api/sessions/:id/stream` (already stubbed) or a WebSocket connection. SSE is simpler and sufficient — full duplex (WebSocket) is not needed since updates only flow server → client.

### Bug fix — parsers.ts PDF Buffer→Uint8Array

`unpdf`'s `getDocumentProxy` requires `Uint8Array`, not Node.js `Buffer`. Fixed in
`src/agent/parsers.ts` — `getPdfParseResult` now wraps with `new Uint8Array(buffer)`
before passing to `getDocumentProxy`. Confirmed working against `hr_requirements.pdf`.

### pnpm test:corpus — 12.06.2026

Updated `src/agent/test-corpus.ts`:

- Now loads all 5 corpus files (added `hr_requirements.pdf`)
- Uses `parseDocument` from `parsers.ts` to read files — PDF goes through `unpdf`
  exactly as the real pipeline will, not via `fs.readFile` text mode
- Added per-issue gate checks for all 5 planted issues

Results with 5-document corpus:

- ✓ 58 requirements, all with sourceDocument
- ✓ 5 conflicts with documentA + documentB
- ✓ 12 gaps found
- ✓ Issue 1: mobile scope conflict (prd_draft vs transcript)
- ✓ Issue 2: EU data residency surfaced from rfp.md
- ✓ Issue 3: delegation gap (prd_draft vs hr_requirements.pdf)
- ✓ Issue 4: notification channel ambiguity
- ✓ Issue 5: SSO/auth conflict (prd_draft vs hr_requirements.pdf)
- Planted issues surfaced: 5/5

### OpenAI quota status

OpenAI key is present and correctly configured. Embeddings blocked by quota exhaustion
(`insufficient_quota` 429). Parse → chunk pipeline confirmed working (562 chars parsed,
1 chunk produced, correct charOffset). Embedding gate items remain pending until quota
is topped up. This does not block Phase 3 — the summarizer reads chunks from DB, but
Phase 3 development can proceed using the existing mocked-embedding chunks from prior
test runs.

Gate: upload a PDF, query semantically related chunks back out.

### Schema cleanup (post-Phase 2)

- `documents.mimeType` and `documents.sizeBytes` added — wired through from upload request
- `chunks.charOffset` (integer), `chunks.pageNumber` (integer), `chunks.headingPath` (text[]) added
- `xstateSnapshot` typed with inline `XStateSnapshot` type to avoid circular dependency with `machine.ts`
- `chunkDocument` refactored to accept `ParseResult` directly — overloads removed
- `addOffsets` post-processing computes `charOffset` per chunk; `pageBoundaries` for PDF page number mapping; `headingIndex` regex scan for Markdown heading paths
- `ts-pattern` adopted in parsers and chunker for exhaustive pattern matching
- All 30 tests passing

---

## Phase 2 — XState Machine Design (COMPLETE)

### Diagram

Stored in `README.md`. Approved after gate review.

### Key decisions

- **Single `error` state** (tutor's recommendation, not used — per-state error substates kept in student's design)
- **`USER_CONFIRM` added as 8th event** — explicit user confirmation before analysis starts; machine doesn't auto-transition from `processing` to `analyzing`
- **`awaiting_answers` has no ERROR transition in V1** — session blocks until user responds; server restart handled via snapshot rehydration
- **Context shape** defined in `src/shared/schemas/machine.ts` as `MachineContextSchema` — used both as TypeScript type and for snapshot validation at rehydration

### Gate

PASSED.

---

## Effect-TS Migration (between Phase 3 and Phase 4)

### Reference

- `docs/effect-smol/` — effect-smol repo as git subtree (run `pnpm docs:effect-update` to pull latest)
- `docs/effect-smol/ai-docs/src/01_effect/02_services/` — `Context.Service` and `Layer` patterns
- `docs/effect-smol/ai-docs/src/01_effect/03_errors/` — typed errors with `Schema.TaggedErrorClass`
- `docs/effect-smol/ai-docs/src/03_integration/10_managed-runtime.ts` — `ManagedRuntime` + Hono bridge

### Philosophy

- XState stays — owns the state machine (transitions, guards, suspend/resume)
- Effect wraps side-effecting work inside XState actors via `Effect.runPromise`
- `ManagedRuntime` is the bridge between Effect's Layer/Service world and Hono's async handlers
- `effect` v4 beta installed (`4.0.0-beta.78`)

### What was built

**`src/storage/index.ts` — `StorageAdapter` service (COMPLETE)**

Full rewrite of storage as an Effect `Context.Service`. All six operations implemented:

| Method                  | Error type          |
| ----------------------- | ------------------- |
| `upload`                | `UploadError`       |
| `download`              | `DownloadError`     |
| `downloadPartialObject` | `DownloadError`     |
| `remove`                | `DeleteError`       |
| `generatePresignedUrl`  | `PresignedUrlError` |
| `headObject`            | `HeadObjectError`   |

Key patterns used:

- `Layer.effect` + `Effect.gen` — `S3Client` constructed once, closed over by all methods
- `Effect.fn("span/name")(generator, ...combinators)` — generator handles core logic, combinators handle transformation and error mapping
- `Effect.tryPromise({ try, catch })` — wraps AWS SDK calls with typed errors
- `Effect.fromNullishOr` + `Effect.catchTag("NoSuchElementError")` — nullable body handling in download
- `Effect.catchDefect` — intercepts untyped AWS exceptions in `headObject`, maps known 403/404 to `false`
- `Effect.map(() => true)` — maps successful `headObject` response to boolean

The old `S3Storage` class (Promise-based) kept alongside `StorageAdapter` during migration. Both coexist in the same file until the full migration is complete.

### How to use `StorageAdapter`

See next section below for integration guidance.

### Full rewrite planned (Phase 9)

See `docs/build_sequence.md` Phase 9 for the complete plan. Key items:

- `DatabaseService` — wrap all Drizzle queries as Effect service, enable mock DB in tests
- `@effect/ai-anthropic` — replace Vercel AI SDK with Effect's typed AI layer
- Parsers + embedder as Effect services
- Delete `S3Storage` class and `StorageAdapter` Promise interface
- Merge all layers in `runtime.ts`

### Remaining migration steps (current)

**Step 2 — Create `ManagedRuntime` in `src/runtime.ts`**

```ts
import { Layer, ManagedRuntime } from "effect";
import { EffectStorageAdapter } from "./storage/index.js";

export const appMemoMap = Layer.makeMemoMapUnsafe();
export const runtime = ManagedRuntime.make(EffectStorageAdapter.layer, { memoMap: appMemoMap });
```

**Step 3 — Hono routes use `runtime.runPromise`**

```ts
app.post('/sessions/upload-url', async (c) => {
  const result = await runtime.runPromise(
    EffectStorageAdapter.use((s) => s.generatePresignedUrl(key, mimeType, 15)).pipe(
      Effect.catchTag("PresignedUrlError", () => Effect.fail(...))
    )
  )
  return c.json(result)
})
```

**Step 4 — Rewrite `process-uploaded-documents.ts`**
Replace `try/catch` + `p-queue` with `Effect.fn` + `Effect.forEach(..., { concurrency: 2 })`.

**Step 5 — Rewrite extractor and challenger with `Effect.fn`**

### XState + Effect bridge

XState actors call `Effect.runPromise(effect.pipe(Effect.provide(runtime)))` inside `invoke.src`. XState owns all state transitions. Effect owns typed errors and DI inside each actor.

---

## Phase 3 — Per-Document Summarization + Challenger (COMPLETE — 15.06.2026)

### What was built

- `src/shared/schemas/agent.ts` — `RequirementSchema`, `DocumentAnalysisSchema`, `ConflictSchema`, `GapReportSchema`, `DocumentAnalysis` and `GapReport` types
- `src/agent/extractor.ts` — `runExtractor(documents)` using `generateText` + `Output.object({ schema: DocumentAnalysisSchema })` via `@ai-sdk/anthropic`
- `src/agent/challenger.ts` — `runChallenger(documents, analysis)` using `generateText` + `Output.object({ schema: GapReportSchema })`
- `src/agent/test-corpus.ts` — integration test script, run with `pnpm test:corpus`
- Both passes have purpose-built system prompts (different from each other)
- Documents passed as `messages` user content with `=== filename ===` headers for source attribution

### Gate verification (pnpm test:corpus output)

- ✓ 30 requirements found (≥3)
- ✓ All items have sourceDocument
- ✓ 3 conflicts found with both documentA and documentB
- ✓ 8 gaps found
- Planted contradiction surfaced: `prd_draft.md` (mobile out of scope) vs `discovery_call_transcript.txt` (CEO hard requirement for mobile)

### Gate

Previously PASSED on the old single-pass Extractor design. **REOPENED** — the design
has changed. Gate must be re-verified against the new acceptance criteria (Phase 3a + 3b).

### Design revision — 11.06.2026

The Extractor is replaced by a per-document **map-reduce summarizer**. Key changes:

- **Chunks as read path:** No analysis pass reads `documents.rawText` directly. Every
  analysis LLM call loads chunks from the `chunks` table.
- **Map-reduce:** For large documents, chunks are batched (default: 20 per batch). Each
  batch produces an intermediate summary (map). Intermediates are reduced into a single
  per-document summary (reduce). Small documents skip map and go directly to reduce.
- **Summarization strategy deferred:** Three options kept open — map-reduce (default),
  hierarchical (recursive pair summarisation), agentic with tools (model queries pgvector).
  Interface in `summarizer.ts` written to be swappable; decision deferred to benchmarking.
- **Summary storage:** separate `document_summaries` table (not a column on `documents`).
  Stores both `map_intermediate` rows (one per batch) and `final` rows (one per document
  per summarization run). `version` increments on re-summarization — history never
  overwritten. `token_count` per row enables the XState context threshold guard without
  re-reading content.
- **Challenger reads summaries:** The Challenger pass receives per-document summaries, not
  raw text. Contradictions between documents are visible at the summary level.
- **XState context updated:** `documentSummaries[]`, `revisionFeedback`, `outputVersion`
  added to machine context shape.
- **`inputMode` guard:** `tokensBelowThreshold` now evaluates summary token counts, not
  raw document token counts. Full-context fallback is still present but is the exception.
- **Architecture Rule 13 added:** Analysis passes must not read `documents.rawText`.
- **Revision loop added (Phase 5b):** `complete → revising → [awaiting_answers?] → generating → complete`.
  Free-form feedback via `POST /api/sessions/:id/revise`. New XState event `REVISION_REQUESTED`,
  new state `revising`. Each revision increments `outputVersion` on outputs rows.
- **Output export added (Phase 5b):** `GET /api/sessions/:id/output/:type/download-url`
  returns a presigned S3 GET URL (short TTL). File bytes never pass through Hono.

**What was built (Phase 3 in progress):**

- `revising` added to `sessionStatusEnum` in `src/db/schema.ts`
- `document_summaries` table added — stores both `map_intermediate` and `final` rows.
  `sourceDocument` column denormalised for query convenience. `tokenCount` used by XState guard.
- `summary_items` table added — normalised requirements/constraints/assumptions, one row per item.
  `confidence_level` and `summary_item_type` enums added.
- Relations wired: `documentSummaries → many summaryItems`, `summaryItems → one documentSummaries`
- `DocumentSummarySchema` + `ItemWithSourceSchema` added to `src/shared/schemas/agent.ts`
- `MachineContextSchema` updated: `documentSummaries[]`, `revisionFeedback`, `outputVersion` added,
  `z.number` bug fixed, `z.literal` → `z.enum` fixed
- `src/db/queries.ts` — `createSummaryItems`, `getFinalSummariesBySession` (JOIN with `summary_items`,
  `reconstructSummaries` helper), `getChunksByDocumentId` all present
- `src/agent/summarizer.ts` — rolling reduce pattern with `for...of` + `Option<DocumentSummary>`,
  `persistSummary` shared helper (inserts summary row then batch-inserts items), `runReducePass`
  with `formatChunk` using `Option.match`. `MapReduceSystemPrompt` written.
  `getCurrentDocumenSummaryVersion` used for version increment on re-summarization.
- `src/agent/challenger.ts` — rewritten to accept `ReconstructedSummary[]`, updated system prompt.
- `src/agent/test-corpus.ts` — rewritten to use full DB pipeline (session + docs + chunks inserted,
  `summarizeAllDocuments` called, finals loaded via JOIN, passed to `runChallenger`).
- `createAgentSession` bug fixed — was returning array not `result[0]`.
- Schema applied via psql directly (drizzle-kit push requires TTY for new enum confirmation).

### Gate verification — 15.06.2026

`pnpm test:corpus` result: 5/5 planted issues surfaced.

- ✓ 5 final summaries in `document_summaries`
- ✓ All have `sourceDocument`
- ✓ Issue 1: mobile scope conflict (prd_draft vs transcript)
- ✓ Issue 2: EU data residency surfaced from rfp.md
- ✓ Issue 3: delegation gap surfaced
- ✓ Issue 4: notification channel ambiguity surfaced
- ✓ Issue 5: SSO/auth conflict (prd_draft vs hr_requirements.pdf)

---

## Architecture Decision — Target Stack (16.06.2026)

Agreed target architecture for the full-stack setup, replacing the current Hono + Vite dev server approach.

### Backend

- **Effect `HttpApiBuilder`** replaces Hono entirely. No Hono in the final stack.
- **Better Auth** handles sessions + OAuth (GitHub/Google). Mounted as a fetch passthrough at `/api/auth/*` — `auth.handler` is a plain `(Request) => Promise<Response>`, so it drops into an `HttpRouter` catch-all with no adapter needed.
- **Auth middleware** via `HttpApiMiddleware` — injects typed `CurrentUser` into handler context. Handlers that require auth won't compile without it.
- **`HttpApi` schema** (`src/api/schema.ts`) is a shared module with zero server imports — imported by both the server (to register handlers) and the frontend (to generate a typed client). Schema changes propagate end-to-end at compile time.
- **Drizzle** stays. Better Auth gets its own DB connection (passed via `drizzleAdapter`), sharing the same Postgres pool.

### Frontend

- **Vite frontend-only** — no `@hono/vite-dev-server`, no API handling in Vite.
- **`@effect/atom-react`** (`4.0.0-beta.83`) for state — atoms backed by `HttpApiClient` calls. Replaces React Query + Zustand in one model. Risk: still beta; fallback is plain `useState`/`useEffect` with `HttpApiClient` if stability becomes a problem.
- **`HttpApiClient.make(Api)`** generates a typed client from the shared `HttpApi` definition. No OpenAPI codegen step.

### Dev setup

```
make dev
  ├── docker compose up -d            (postgres + rustfs)
  ├── tsx --watch src/server.ts        (Effect API, port 3000)
  └── vite                            (frontend only, port 5173, proxies /api → 3000)
```

`concurrently` used for the two-process `dev` target. Individual `make infra`, `make migrate`, `make test` targets alongside.

`vite.config.ts` gains:

```ts
server: { proxy: { "/api": "http://localhost:3000" } },
preview: { proxy: { "/api": "http://localhost:3000" } },
```

### Production serving

Single `node src/server.js` process. The Effect server serves both the API and the `dist/` static files via `HttpServerResponse.file` + SPA fallback (`HttpRouter.get("*", ...)` catching `SystemError`/`BadArgument` from missing files → `index.html`). No nginx required.

### What this replaces / supersedes

- Removes: `@hono/vite-dev-server` plugin from `vite.config.ts`
- Removes: Hono from `src/api/index.ts` and `src/index.ts`
- Removes: `ManagedRuntime` bridge in `src/runtime.ts` (Effect `HttpApiBuilder` owns the whole request lifecycle)
- Keeps: Drizzle, Effect agent logic, XState, all DB schema unchanged
- Keeps: `src/server.ts` as the single entry point (currently experimental, becomes canonical)

### Open questions before implementation

1. `@effect/atom-react` beta risk — decide at Phase 10 (React SPA) whether to commit or fall back to plain hooks.
2. Better Auth + Drizzle v1 beta compatibility — originally deferred (see Phase 1 key decisions). Re-evaluate when drizzle reaches stable 1.0 or when auth becomes a build sequence requirement.

---

## Mentor Notes — 03.07.2026

Items raised in mentor review. Categorised by urgency.

### Apply before Phase 1 gate

- **`agent/parsers.ts` — use `path.extname()`** instead of the regex to extract file extension. Also use `fileTypeFromStream` (not `fileTypeFromBuffer`) connected to a `downloadPartialObject` call — read only the first N bytes from S3 to verify MIME type matches content before full download. A `.txt` file can be a disguised binary.
- **`chunker.ts` — minimum chunk size guard** — short paragraphs can produce very small chunks that degrade embedding quality. Add a minimum chunk size (e.g. 100 chars). Merge chunks below the minimum with the previous chunk rather than emitting them standalone.
- **`chunker.ts` — return chunk metadata** — return `{ content: string, meta: ChunkMeta }[]` not just `string[]`. Metadata per file type: PDF → page number, Markdown → heading path, all → char offset. Needed for accurate source attribution in LLM prompts. **Decided:** use `LocationMeta` jsonb column on `chunks` table: `{ pageNumber?: number, headingPath?: string, charOffset?: number }`. Nullable — plain text has no page/heading. Column typed with `.$type<LocationMeta | null>()`.
- **`db/schema.ts` — type JSON columns with `$type()`** — Drizzle's `jsonb()` column builder supports `.$type<T>()` to give the column a proper TypeScript type instead of `unknown`. Apply to `xstateSnapshot` at minimum.
- **`db/queries.ts` — Data Transfer Objects** — define explicit DTO types for DB inputs/outputs rather than using raw Drizzle inferred types directly in query functions. Keeps the DB layer decoupled from the rest of the application.

### Apply before Phase 3 (agent passes)

- **`content` and `embedding` are the same concept** — the `chunks` table stores both `content` (text) and `embedding` (vector of that text). This is correct and intentional, but worth making explicit in code comments so it's clear they're two representations of the same information.
- **`ts-pattern`** — consider using `ts-pattern` for exhaustive pattern matching in the agent pipeline (file type dispatch, XState event handling). Makes unhandled cases a compile error.

### Deferred — fine-tuning phase (after Phase 8)

- **Streaming parsing and chunking** — current approach buffers entire files before parsing. For large files or concurrent users this risks memory exhaustion. Long-term: pipe S3 download stream directly into the parser, chunk on the stream. Requires checking `unpdf` and `mammoth` stream support. Alternatively: process queue with concurrency limit (1–3 files at a time).
- **`embedChunks` batch limit** — `embedMany` has a default request size limit. For large documents with many chunks, implement batching with a configurable batch size before calling `embedMany`.
- **Document cleanup background job** — schedule a job to delete orphaned documents (documents not connected to any existing session) and their chunks + S3 objects. Prevents storage accumulation from incomplete sessions.
- **SSE / WebSocket for status updates** — current polling on `GET /api/sessions/:id` works for V1. Replace with SSE via `POST /api/sessions/:id/stream` when building the React SPA (Phase 9). Full duplex (WebSocket) not needed — updates only flow server → client.

---

## Codebase audit cleanup — 17.06.2026

Full audit of `src/` vs docs completed. The following fixes were applied:

### Code fixes
- **`src/agent/extractor.ts` deleted** — dead code. Imported `DocumentAnalysisSchema` that no
  longer exists, used `TextGenerationError` without importing it, violated Rule 13 (raw text to LLM).
- **`src/db/queries.ts` — `reconstructSummaries` bug fixed** — `DISTINCT ON` + `leftJoin`
  collapsed to one row per document, so `requirements`/`constraints`/`assumptions` arrays were
  always 0–1 items. Fixed by using two separate queries (summaries, then items) and grouping
  in TypeScript.
- **`src/shared/schemas/agent.ts`** — `ClarifyingQuestionsSchema` and `ClarifyingQuestionSchema`
  now exported. Phase 4 (`question-generator.ts`) requires them.
- **`src/shared/schemas/machine.ts`** — stale import from `db/out/schema.ts` replaced with
  import from `db/schema.ts` directly (`documentTypeEnum.enumValues`).
- **`src/storage/index.ts`** — `"shipwreck/..."` typo fixed to `"shipwright/..."` in all error
  tags and the service identifier. Dead `yield* Effect.void` stub removed.
- **`src/agent/errors.ts`** — error tags now follow `"shipwright/module/ErrorName"` convention.
- **`src/agent/estimate-token-count.ts`** — encoder is now a module-level singleton (was
  re-instantiated on every call, loading WASM each time).

### Docs updates
- **`docs/stack.md`** — API layer updated from "Hono + Hono RPC" to "Effect HttpApi". DB layer
  section updated to document Effect DatabaseService migration. Agent/Orchestration section updated
  to describe Effect's actual role. Final Stack Summary table updated.
- **`docs/architecture_rules.md`** — Rules 6, 7, 8, 10 updated to reflect Effect HttpApi and
  AI SDK v6 (`Output.object()` instead of deprecated `generateObject`).
- **`docs/build_sequence.md`** — Phase 0 project structure updated to actual layout. Phase 6
  updated from "Hono API" to "Effect HttpApi wiring".
- **`docs/progress.md`** (this file) — Quick-start stack description updated, architecture
  deviations documented explicitly.

### Still outstanding (not fixed in this session)
- `src/agent/parsers.ts` — uses `fileTypeFromBuffer` instead of `fileTypeFromStream` (Rule 12
  violation). Fix: connect to `downloadPartialObject` for first-N-bytes verification.
- `src/agent/chunker.ts` — no minimum chunk size guard (build sequence requirement).
- `src/server/server.ts` — broken relative import paths (`./db/`, `./storage/`, `./shared/`
  don't resolve correctly from `src/server/`). Fix when wiring Phase 4.
- `src/shared/schemas/api.ts` — `PostAgentSessionAnswersRequest.answers` is `string[]` not
  `{questionId, text}[]`. Fix in Phase 4 when implementing the answers endpoint.
