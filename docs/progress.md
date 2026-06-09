# Build Progress Log

> Running log of completed phases, decisions made, and issues encountered.
> Read this before starting a new session.

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

**`src/storage/index.ts` — `EffectStorageAdapter` service (COMPLETE)**

Full rewrite of storage as an Effect `Context.Service`. All six operations implemented:

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
- `Effect.fn("span/name")(generator, ...combinators)` — generator handles core logic, combinators handle transformation and error mapping
- `Effect.tryPromise({ try, catch })` — wraps AWS SDK calls with typed errors
- `Effect.fromNullishOr` + `Effect.catchTag("NoSuchElementError")` — nullable body handling in download
- `Effect.catchDefect` — intercepts untyped AWS exceptions in `headObject`, maps known 403/404 to `false`
- `Effect.map(() => true)` — maps successful `headObject` response to boolean

The old `S3Storage` class (Promise-based) kept alongside `EffectStorageAdapter` during migration. Both coexist in the same file until the full migration is complete.

### How to use `EffectStorageAdapter`

See next section below for integration guidance.

### Remaining migration steps

**Step 2 — Create `ManagedRuntime` in `src/runtime.ts`**
```ts
import { Layer, ManagedRuntime } from "effect"
import { EffectStorageAdapter } from "./storage/index.js"

export const appMemoMap = Layer.makeMemoMapUnsafe()
export const runtime = ManagedRuntime.make(
  EffectStorageAdapter.layer,
  { memoMap: appMemoMap }
)
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

## Phase 3 — Single Agent Pass (COMPLETE)

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
PASSED.

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
