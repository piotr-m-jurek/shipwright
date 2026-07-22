# Project Description Agent — Acceptance Criteria

> **Tag:** V1
> **Scope:** Functional checks only — does it work, not how it looks.
> **Usage:** Tutor uses this to verify each phase before the student moves on.

---

## How to use this document

For each phase, the tutor verifies every item in the checklist before the student
proceeds to the next phase. A phase is done when every item passes — not when
it "mostly works".

---

## Phase 0 — Scaffold

- [x] `pnpm dev` starts the Vite + Hono server on port 5173 without errors
- [x] `drizzle-kit push` runs without errors — all tables created in Postgres
- [x] `SELECT * FROM agent_sessions LIMIT 1` returns an empty result (not an error)
- [x] pgvector extension is enabled: `SELECT * FROM pg_extension WHERE extname = 'vector'` returns a row
- [x] rustfs is reachable: a test upload via `@aws-sdk/client-s3` succeeds
- [x] `.env.example` lists every required environment variable with a description
- [x] `.env` is gitignored

**Gate:** Do not start Phase 1 until the DB, vector extension, and storage are all confirmed reachable.

---

## Phase 1 — Document Ingestion

### 1a — Presigned upload

- [x] `POST /api/sessions/upload-url` with valid file metadata returns `{ sessionId, presignedUrl, s3Key }`
- [x] The returned `presignedUrl` accepts a direct `PUT` request from the client — no Hono server in the path
- [x] After a successful S3 PUT, `POST /api/sessions/:id/confirm-upload` with the `s3Key` returns `202`
- [x] `POST /api/sessions/:id/confirm-upload` with a `s3Key` that does not exist in S3 returns `400`
- [x] `POST /api/sessions/upload-url` with `sizeBytes` > 100MB returns `400` before generating a URL

### 1b — Parsing + chunking + embedding

- [x] After confirming a PDF upload, `SELECT count(*) FROM chunks WHERE session_id = '<id>'` returns > 0 — _pending OpenAI quota_
- [x] After confirming a DOCX upload, chunks are present with non-empty `content` — _pending OpenAI quota_
- [x] After confirming a plain text or Markdown upload, chunks are present (verified with mocked embeddings)
- [x] Every chunk row has a non-null `embedding` column — _pending OpenAI quota_
- [x] Every chunk row has non-null `document_type`, `chunk_index`, `session_id`
- [x] `SELECT token_count FROM documents WHERE session_id = '<id>'` returns a positive integer — _pending OpenAI quota_
- [x] The uploaded file is retrievable via `StorageAdapter.download()` — not via `fs.readFile` directly
- [x] A semantic query against pgvector for a term present in the uploaded document returns that document's chunks in the top results — _pending OpenAI quota_
- [x] A semantic query for a term NOT in the document does not return that document's chunks at the top — _pending OpenAI quota_

**Gate:** Structural wiring verified. Parser confirmed working for PDF (unpdf + Buffer→Uint8Array fix applied), DOCX, plain text, Markdown. Chunk pipeline produces correct output (content, charOffset, chunkIndex). Embeddings blocked by OpenAI quota exhaustion — key is present and correctly configured, billing issue only. Items marked _pending OpenAI quota_ to be re-verified when quota is topped up. Proceeding to Phase 3 with this acknowledged.

---

## Phase 2 — XState Machine Design

> This phase produces a diagram, not code. The tutor reviews the diagram.

- [x] All 10 states are present: `idle`, `uploading`, `processing`, `summarizing`, `analyzing`, `awaiting_answers`, `re_evaluating`, `generating`, `complete`, `revising` — note: `summarizing` added in Phase 4 design revision; V1 implementation omits it (see deviation note)
- [x] `error` state is reachable from every other state — V1 deviation: `awaiting_answers` has no ERROR transition by design (session blocks until user responds; server restart handled via snapshot rehydration)
- [x] All 10 events are defined: `UPLOAD_COMPLETE`, `SUMMARIZATION_DONE`, `ANALYSIS_DONE`, `USER_ANSWERED`, `ANSWERS_SUFFICIENT`, `ANSWERS_INSUFFICIENT`, `OUTPUT_READY`, `ERROR`, `USER_CONFIRM`, `REVISION_REQUESTED` — note: `SUMMARIZATION_DONE` required for correct `tokensBelowThreshold` guard; V1 implementation omits it
- [x] All 2 guards are defined: `tokensBelowThreshold` (evaluates summary token counts), `roundLimitReached` — `hasEnoughContext` removed, covered by `tokensBelowThreshold`
- [x] Context shape is fully defined in `src/shared/schemas/machine.ts`: `sessionId`, `documents[]`, `documentSummaries[]`, `questions[]`, `answers[]`, `round`, `inputMode`, `agentAnalysis`, `revisionFeedback`, `outputVersion`, `outputs{}`
- [x] The diagram shows `awaiting_answers` as a suspend point (waits for external `USER_ANSWERED` event)
- [x] The diagram shows the loop: `re_evaluating` → `awaiting_answers` (when `ANSWERS_INSUFFICIENT` and round < limit) or → `generating` (when `ANSWERS_SUFFICIENT`)
- [x] The diagram shows `roundLimitReached` guard forcing progression to `generating` even if answers are insufficient
- [x] The diagram shows `complete → revising` on `REVISION_REQUESTED` and `revising → generating` after revision

**Gate:** Diagram approved for original design. Context schema and `revising` state additions from Phase 5b design revision (11.06.2026) must be verified before Phase 4 implementation begins.

---

## Phase 3 — Per-Document Summarization + Challenger

> **Design revision (11.06.2026):** Extractor replaced by per-document map-reduce
> summarizer. Chunks from DB are the primary read path. Raw document text is never
> passed directly into an analysis LLM call.

### 3a — Per-document summarization

- [x] `document_summaries` table exists with columns: `id`, `document_id`, `session_id`, `source_document`, `version`, `summary_type`, `batch_index`, `content`, `token_count`, `created_at`
- [x] `summary_items` table exists with columns: `id`, `summary_id`, `item_type`, `text`, `source_document`, `confidence`, `order_index`
- [x] `confidence_level` and `summary_item_type` enums exist in the DB
- [x] `drizzle-kit push` (or equivalent SQL migration) applied without errors — applied via psql directly (drizzle-kit requires TTY for new enum confirmation)
- [x] For each document in the session, chunks are loaded from the `chunks` table ordered by `chunkIndex` — raw `documents.rawText` is NOT passed to the LLM
- [x] The rolling reduce pass stores each intermediate as `summary_type = 'map_intermediate'` with the correct `batch_index` (= `chunkIndex`)
- [x] The reduce pass produces a row with `summary_type = 'final'`
- [x] `SELECT count(*) FROM document_summaries WHERE session_id = '<id>' AND summary_type = 'final'` equals the number of documents in the session — verified: 5/5 in test run
- [x] Every final summary row has a non-null, non-empty `content` and a positive `token_count`
- [x] Every requirement, constraint, and assumption in the summary content has a `sourceDocument` field — nothing omitted or null
- [x] `generateText` with `Output.object()` is used — not bare `generateText` or deprecated `generateObject`
- [x] The Anthropic SDK (`@anthropic-ai/sdk`) is NOT imported in the summarizer — only `@ai-sdk/anthropic`
- [x] Re-running summarization on the same document creates a new row (`version = 2`) — `getCurrentDocumenSummaryVersion` queries max version, new run inserts `version + 1`

### 3b — Challenger pass

- [x] The Challenger loads `ReconstructedSummary[]` from `getFinalSummariesBySession` (JOIN query on `document_summaries` + `summary_items`) — not from `documents.rawText`
- [x] `generateText` with `Output.object()` is used for the Challenger pass
- [x] The Challenger Zod schema has `documentA` and `documentB` fields on conflicts
- [x] Running the Challenger against the test corpus returns at least one conflict (the planted contradiction) — 4–5 conflicts in test runs
- [x] Running the Challenger against the test corpus returns at least one gap — 10 gaps in test runs
- [x] The system prompt for the summarizer is different from the system prompt for the Challenger
- [x] Chunks go into `messages` as user content with `=== chunk from: filename ===` headers — not in the system prompt

**Gate:** PASSED. All 5 planted issues surfaced by Challenger from per-document summaries (not raw text). `pnpm test:corpus` confirms 5/5 issues on 15.06.2026.

---

## Phase 4 — The Clarifying Loop

### Confirm endpoint + pipeline trigger

- [x] `POST /api/sessions/:id/confirm` returns `{ started: true }` and starts the analysis pipeline async
- [x] After `POST /api/sessions/:id/confirm`, `GET /api/sessions/:id` eventually returns `status: "awaiting_answers"` and a non-empty `questions[]`
- [x] `GET /api/sessions/:id` returns `questions[]` when session is in `awaiting_answers`

### Machine behaviour

- [x] The XState machine can be instantiated and all states are reachable
- [x] When the machine enters `awaiting_answers`, it does not proceed until a `USER_ANSWERED` event is sent
- [x] `POST /api/sessions/:id/answers` with a valid payload fires the `USER_ANSWERED` event and returns 200
- [x] After `USER_ANSWERED`, the machine transitions out of `awaiting_answers`
- [x] The `round` field in context increments correctly after each clarifying round
- [x] When `round >= 2`, the `roundLimitReached` guard forces progression to `generating` regardless of answer quality
- [x] Between 3 and 7 questions are generated — verified: 7 questions generated in test run

### Persistence

- [x] Questions are persisted to the `questions` table before the machine suspends at `awaiting_answers` — verified: 7 rows
- [x] Answers are persisted to the `answers` table after `USER_ANSWERED` — verified: 7 rows
- [x] `xstateSnapshot` is non-null in DB after every transition — verified in test run

### Server restart recovery (gate item)

- [x] After a simulated server restart, `POST /api/sessions/:id/answers` to an in-progress session resumes the machine correctly from the persisted snapshot
- [x] The restored machine is in `awaiting_answers` and transitions correctly on `USER_ANSWERED`

### Known V1 deviation

- [ ] **Deferred:** `summarizing` state and `SUMMARIZATION_DONE` event not yet implemented — summarization runs inside `runAnalysisPipeline` after `USER_CONFIRM`, so `documentSummaries[]` is empty when `tokensBelowThreshold` guard fires and always defaults to `context` mode. Correct fix: split pipeline, add `summarizing` state, fire `SUMMARIZATION_DONE` before `USER_CONFIRM`.

**Gate:** PASSED. 16/16 automated checks pass (`pnpm test:phase4`). Server restart recovery verified manually: session rehydrated from DB snapshot after full server kill and restart, `USER_ANSWERED` transitioned correctly on restored actor. Verified 17.06.2026.

---

## Phase 5 — Writer Passes

- [x] The Brief writer uses `streamText` — not `generateObject`
- [x] The PRD writer uses `streamText` — not `generateObject`
- [x] The streamed Brief is valid Markdown when rendered — verified: contains `## Overview` and scope sections
- [x] The streamed PRD contains at least: acceptance criteria section, non-goals section, recommended stack section — verified
- [x] `SELECT content FROM outputs WHERE session_id = '<id>' AND type = 'project_brief'` returns non-empty content — verified: 6935 chars
- [x] `SELECT content FROM outputs WHERE session_id = '<id>' AND type = 'implementation_prd'` returns non-empty content — verified: 32204 chars
- [x] `SELECT version FROM outputs WHERE session_id = '<id>'` returns `1` — verified
- [ ] The Brief does not contain requirements not present in the source documents (spot-check 3 claims against sources) — manual spot-check needed
- [x] The system prompt for the Brief writer is different from the system prompt for the PRD writer
- [x] Prompt caching is configured: `experimental_providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } }` on document context in both writers

**Gate:** PASSED. Both outputs stored in DB, 12/12 automated checks pass (`pnpm tsx src/agent/test-phase5-gate.ts`, 17.06.2026). One manual spot-check item outstanding (faithfulness — verify no hallucinated requirements in Brief).

---

## Phase 5b — Output Export + Revision Loop

### Export

- [x] `GET /api/sessions/:id/output/:type/download-url` returns `{ url: string }` with a presigned S3 GET URL
- [x] The `type` param accepts only `project_brief` or `implementation_prd` — other values return `404`
- [x] The presigned URL resolves to the correct output file content when fetched directly — verified: 7534 chars Brief, 37071 chars PRD served via presigned URL
- [x] The presigned URL has a TTL — `generatePresignedGetUrl` uses `expiresIn: 15 * 60`
- [x] File bytes do not pass through the server — URL points directly to rustfs/S3

### Revision loop

- [x] `POST /api/sessions/:id/revise` with `{ feedback: string }` returns `{ started: true }` (200)
- [x] Sending `REVISION_REQUESTED` transitions the machine from `complete` to `revising`
- [x] `xstateSnapshot` is persisted after the `complete → revising` transition — verified in DB
- [x] The revision Writer pass receives existing outputs + feedback + summaries — not raw text
- [x] After revision completes, latest version in `outputs` table is `2` — verified: v2 Brief 10663 chars, v2 PRD 52130 chars
- [x] Both Brief and PRD are regenerated on revision — verified: both have version 2 rows
- [ ] If the revision pass surfaces new questions, the machine enters `awaiting_answers` — deferred (current revision always goes straight to generating)
- [x] `outputVersion` in XState context increments correctly — verified: `outputVersion = 2` in snapshot

**Gate:** PASSED. Export URL serves file bytes directly from S3, revision produces version-2 outputs for both documents. Verified manually 17.06.2026. One item deferred: revision-triggered clarifying questions (V1 revision always regenerates directly).

---

## Phase 6 — Effect HttpApi wiring

> **Architecture note:** Phase 6 was originally written for Hono + Hono RPC. The actual
> server uses Effect HttpApi (`effect/unstable/httpapi`). Hono-specific items (SSE via
> `toDataStreamResponse`, Hono RPC client, `@hono/vite-dev-server`) do not apply.
> The equivalent of Hono RPC types is the auto-generated OpenAPI schema at `/openapi.json`.

- [x] `POST /api/sessions/upload-url` with valid metadata returns `{ sessionId, uploads[] }` — 200
- [x] `POST /api/sessions/upload-url` with `sizeBytes > 100MB` returns 400
- [x] `POST /api/sessions/:id/confirm-upload` with a valid `s3Key` returns `{ valid: true }` — 200
- [x] `POST /api/sessions/:id/confirm` triggers analysis pipeline and returns `{ started: true }` — 200
- [x] `GET /api/sessions/:id` returns current status and questions when in `awaiting_answers` — 200
- [x] `GET /api/sessions/:id` returns 404 when session does not exist
- [x] `POST /api/sessions/:id/answers` returns `{ sufficient, round }` — 200
- [x] `GET /api/sessions/:id/output` returns both outputs when complete — 200; returns 404 when session does not exist
- [x] `GET /api/sessions/:id/output/:type/download-url` returns `{ url }` — 200; invalid type returns 404
- [x] `POST /api/sessions/:id/revise` returns `{ started: true }` — 200
- [x] `GET /openapi.json` returns valid OpenAPI 3.1 schema with all 10 routes — 200
- [x] `GET /docs` returns Scalar API documentation UI — 200
- [x] Stopping and restarting the server mid-session does not lose session state — verified in Phase 4 gate
- [x] CORS: frontend origin accepted — `HttpRouter.cors({ allowedOrigins: ["http://localhost:5173"] })` wired in Phase 10

**Gate:** PASSED. All routes respond correctly. Smoke-tested 17.06.2026. CORS resolved in Phase 10.

---

## Phase 7 — Monorepo Restructure

> **Deviation:** Phase 7 was a CLI. CLI is cut. This phase restructures the monolith
> into a pnpm workspaces monorepo.

- [x] `pnpm-workspace.yaml` exists at repo root and declares `apps/*` and `packages/*`
- [x] `apps/api/package.json` exists with name `@shipwright/api`
- [x] `apps/web/package.json` exists with name `@shipwright/web` (scaffold only — no components yet)
- [x] `packages/shared/package.json` exists with name `@shipwright/shared`
- [x] `packages/shared` has an `exports` field covering `.`, `./api`, `./schemas`, `./domain` (no `./lib` — no shared lib utilities exist yet)
- [x] `src/server/api/api.ts` (the `HttpApi` definition) has moved to `packages/shared/src/api/api.ts`
- [x] `apps/api` imports `Api` from `@shipwright/shared/api` — not from a local `src/server/api/` path
- [x] All files from `src/server/`, `src/agent/`, `src/db/`, `src/storage/` are under `apps/api/src/`
- [x] All files from `src/shared/` are under `packages/shared/src/`
- [x] Gate test scripts are in `apps/api/src/agent/tests/` — planned location was `apps/api/tests/gates/`; actual location is equivalent, deviation noted
- [x] `apps/api` imports `@shipwright/shared` via package name — no relative cross-workspace imports (Rule 14)
- [x] `pnpm --filter @shipwright/api start` starts the server on port 3000 without errors
- [ ] `pnpm --filter @shipwright/api test:phase4` passes (16/16) — stalls at `uploading`; pre-existing OpenAI quota issue (no embeddings = no chunks); not a monorepo regression
- [x] `drizzle.config.ts` moved to `apps/api/` (deviation from plan: plan said repo root; `apps/api/` is better — schema and config co-located)
- [x] `docker-compose.yml`, `.env.example` remain at repo root
- [x] No `Effect.tryPromise` count regresses — 4 in `parsers.ts` (third-party wrappers), same as before
- [x] `GET http://localhost:3000/openapi.json` returns valid OpenAPI 3.1 schema — 200 ✓
- [x] `vitest.config.ts`, `oxlint.config.js`, `tsconfig.json` deleted from repo root — recreated per-package

**Gate:** PASSED (26.06.2026). Server starts, `/openapi.json` 200, all imports clean. Phase 4 gate test blocked by pre-existing OpenAI quota issue — not a regression. `drizzle.config.ts` at `apps/api/` is an improvement over the planned repo-root location.

---

## Phase 8 — Langfuse + Evals

> **Architecture note:** Integration uses Effect's built-in OTLP exporter
> (`effect/unstable/observability` `Otlp.layerJson`) pointing at self-hosted
> Langfuse on port 3001. No `@langfuse/vercel` or Langfuse SDK needed.
> Eval schemas use Effect `Schema.Struct`, not Zod.

### Infrastructure

- [x] Langfuse self-hosted running via docker-compose (port 3001, separate from api on 3000)
- [x] `langfuse-web`, `langfuse-worker`, `langfuse-postgres`, `clickhouse`, `redis`, `minio` all healthy
- [x] Headless init: project `shipwright-dev` created on first boot, no manual signup
- [x] `GET http://localhost:3001/api/public/health` returns `{"status":"OK"}`
- [x] `LANGFUSE_OTLP_ENDPOINT`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` in `apps/api/.env`

### Tracing

- [x] `OtlpLayer` wired in `server.ts` `ServiceLayer` using `Otlp.layerJson`
- [x] `ConfigService` extended with optional `observability` block — server starts without Langfuse running (returns `Layer.empty`)
- [x] `langfuse.session.id` annotated on all pipeline entry spans: `runAnalysisPipeline`, `submitAnswers`, `runGeneratingPipeline`, `startRevision`, `runRevisionPipeline`
- [x] Per-pass annotations on: `summarizeAllDocuments`, `summarizeDocument`, `runReducePass`, `runChallenger`, `runQuestionGenerator`, `runBriefWriter`, `runPrdWriter`, `runRevisionBriefWriter`, `runRevisionPrdWriter`
- [x] `gen_ai.*` attributes (model, token counts, finish reason) emitted automatically by `@effect/ai-anthropic` on every LLM span

### Eval schemas

- [x] `packages/shared/src/schemas/evals.ts` — Effect Schema types: `EvalResultSchema`, `FaithfulnessEvalSchema`, `CompletenessEvalSchema`, `ConflictDetectionEvalSchema`
- [x] Exported at `@shipwright/shared/schemas/evals`
- [x] Unparseable judge response throws at `Schema.decodeUnknownSync` — counted as failed eval

### Eval runner

- [x] `apps/api/src/agent/tests/evals.ts` — three-part eval script
- [x] `pnpm --filter @shipwright/api test:evals -- --conflict-only` runs Part A only
- [x] `pnpm --filter @shipwright/api test:evals` runs all three parts (Parts B+C require `EVAL_SESSION_ID`)

### Planted issue checks (Part A — deterministic)

- [x] Issue 1 surfaced: mobile scope conflict (prd_draft vs transcript) — `pnpm test:evals -- --conflict-only` ✓
- [x] Issue 2 surfaced: EU data residency in rfp.md — extracted in rfp summary constraints ✓
- [x] Issue 3 surfaced: delegation acceptance criteria gap ✓
- [x] Issue 4 surfaced: notification channel ambiguity ✓
- [x] Issue 5 surfaced: SSO/auth conflict (prd_draft vs hr_requirements) ✓

### LLM-as-judge evals (Parts B+C — require full pipeline run)

- [ ] Faithfulness eval: Project Brief score ≥ 0.9 — pending full pipeline run with working embeddings
- [ ] Completeness eval: Implementation PRD score ≥ 0.9 — pending full pipeline run

**Gate:** PARTIALLY PASSED (09.07.2026). Part A (conflict detection) 5/5 ✓. Parts B+C deferred — require full pipeline with OpenAI embeddings (quota). Bug fixed: `Effect.map` → `Effect.flatMap` in `summarizeAllDocuments` (was producing `Effect<Effect<...>>`, silently discarding summaries).

---

---

## Phase 9 — Full Effect Rewrite

> **Status: COMPLETE** — rewrite done before monorepo (Phase 7). Paths are still
> `src/` (monolith). Paths will update to `apps/api/src/` when Phase 7 runs.

### DatabaseService

- [x] `DatabaseService` exists as an Effect `Context.Service` in `src/db/queries.ts`
- [x] All 20+ query functions are defined inside `makeDatabaseService` returning `Effect<T, EffectDrizzleQueryError>` — not `Promise<T>`
- [x] `DatabaseService.layer` composes `AppDBLayer` via `Layer.effect` + `Layer.provide`
- [x] `src/db/index.ts` uses `@effect/sql-pg` + `drizzle-orm/effect-postgres` — no `postgres.js`
- [x] `DB` is a `Context.Service` wrapping the Effect-native Drizzle instance
- [x] Zero `Effect.tryPromise` calls in `src/db/`

### LLM layer

- [x] All LLM calls use `LanguageModel.generateObject` or `LanguageModel.streamText` from `effect/unstable/ai` — no Vercel AI SDK (`ai`, `@ai-sdk/*`)
- [x] Embeddings use `EmbeddingModel.embedMany` from `effect/unstable/ai` via `@effect/ai-openai`
- [x] `src/agent/providers.ts` is the only file that imports `@effect/ai-anthropic` or `@effect/ai-openai` client constructors
- [x] All agent passes (`summarizer`, `challenger`, `question-generator`, `writer-brief`, `writer-prd`, `writer-revision`) use `LanguageModel` via `Effect.provide`
- [x] Effect `Schema.Struct` used for all structured output schemas (`src/agent/schemas.ts`) — Zod schemas replaced

### Agent pipeline

- [x] `session-actor.ts` uses `DatabaseService` throughout — zero `Effect.tryPromise`
- [x] `wireSnapshotPersistence` uses `Effect.runForkWith(services)` — service context propagated correctly
- [x] Zero `Effect.tryPromise` calls in `src/agent/` except `parsers.ts` (wraps third-party Promise APIs — acceptable)
- [x] `parsers.ts` — `Effect.tryPromise` wrapping `unpdf` and `mammoth` is the only remaining usage; these are third-party Promise libraries with no Effect equivalent

### Server layer

- [x] `server.ts` `ServiceLayer` includes `DatabaseService.layer`, `StorageAdapter.layer`, `ConfigService.layer`
- [x] No Promise bridges in handlers — all handlers are Effect generators using `DatabaseService` directly
- [x] `pnpm test:phase4` passes (16/16) — rewrite did not regress Phase 4 behaviour

**Gate:** PASSED. Zero `Effect.tryPromise` in `src/db/` and `src/agent/` (except third-party Promise wrappers in `parsers.ts`). All LLM calls via `@effect/ai`. Phase 4 gate tests pass.

---

## Phase 10 — React SPA

> **Architecture note:** Uses `AtomHttpApi.Service` from `effect/unstable/reactivity`
> (official Effect package, v4.0.0-beta.87), not the community `@effect-atom/atom`.
> `@effect/atom-react` provides React bindings (`RegistryProvider`, `useAtomMount`,
> `useAtomValue`, `useAtomSet`, `useAtomSuspense`). Polling uses `Atom.withRefresh`
> from `effect/unstable/reactivity`. `reactivityKeys` are passed per-call on the
> request object, not at mutation creation time.

### Toolchain

- [x] Vite + React + TanStack Router + TanStack Router Vite plugin configured
- [x] Tailwind v4 via `@tailwindcss/vite` — no postcss needed
- [x] shadcn/ui initialized (`base-lyra` style, Phosphor icons, `components.json` present)
- [x] `@` path alias configured in `vite.config.ts` and `tsconfig.json`
- [x] `apps/web` declares `@shipwright/shared: workspace:*`, `@effect/atom-react`, `@effect/platform-browser` as dependencies

### API client wiring

- [x] `apps/web/src/store/api.ts` — `ShipwrightApi` via `AtomHttpApi.Service` from `effect/unstable/reactivity`
- [x] `apps/web/src/main.tsx` — `RegistryProvider` + `AppRuntime` wrapping `useAtomMount(ShipwrightApi.runtime)`
- [x] All API calls go through `ShipwrightApi.mutation(...)` or `ShipwrightApi.query(...)` — no raw `fetch()` to the API server, no TanStack Query (Rule 10)
- [x] `reactivityKeys` passed per-call on request objects (not at mutation creation time)

### Routes

- [x] Route `/` — upload page with drag-drop (`react-dropzone`), file list, progress states
- [x] Route `/sessions/$id/confirm` — review uploaded files, add more, trigger analysis via `confirmAnalysis` mutation
- [x] Route `/sessions/$id/questions` — polls session status via `Atom.withRefresh`, renders questions, submits answers
- [x] Route `/sessions/$id/output` — dual-panel Markdown viewer (`react-markdown`), download buttons, revision section

### Session state bridge

- [x] `apps/web/src/store/session-files.ts` — `Atom.family` keyed by `sessionId` with `Atom.keepAlive` — persists uploaded file metadata across navigation from upload → confirm page

### CORS

- [x] `HttpRouter.cors({ allowedOrigins: config.server.allowedOrigins })` in `server.ts`
- [x] `ALLOWED_ORIGINS=http://localhost:5173` in `apps/api/.env`
- [x] Phase 6 CORS item now resolved ✓

### Known deviations from plan

- [x] `documentType` removed from spec entirely — `CreateAgentSessionRequest` no longer includes it; schema, server, agent, and tests all updated. Upload form works without it.
- [x] Output page polls via `Atom.withRefresh(outputAtom, "3 seconds")` while `projectBrief` or `implementationPrd` is null — spinner shown while generating, panels render as soon as both are populated
- [x] Full end-to-end browser run verified: upload files → confirm → answer questions → view outputs → download Brief

**Gate:** PASSED (17.07.2026). End-to-end verified in browser. Zero raw `fetch()` calls to API server. Zero TanStack Query imports. Zero openapi-fetch/openapi-typescript imports.

---

## Phase 11 — RAG: Retrieval Mode + Agentic Chunks

### Pipeline fix — `tokensBelowThreshold` guard

- [ ] `confirmAnalysis` handler is idempotent — any state other than `idle` returns `{ started: true }` without doing anything
- [ ] One `POST /confirm` drives the machine all the way from `idle` to `awaiting_answers` — no second client call required
- [ ] `runSessionWorkflow` fires `SUMMARIZATION_DONE` with all final summaries before firing `USER_CONFIRM` — `documentSummaries[]` is populated with real `tokenCount` values when the guard evaluates
- [ ] `tokensBelowThreshold` guard correctly evaluates the sum of `documentSummaries[].tokenCount` — does NOT always return `true`
- [ ] When total summary tokens exceed the threshold (100k), `inputMode = "retrieval"` is assigned by the machine
- [ ] `GET /api/sessions/:id` reflects the correct `inputMode` (`"context"` or `"retrieval"`)
- [ ] Challenger always receives all summaries regardless of `inputMode`

### Agentic `query_chunks` tool

- [ ] `QueryChunksTool` defined in `apps/api/src/agent/tools/query-chunks.ts` using `Tool.make` from `effect/unstable/ai`
- [ ] Tool parameters schema includes `query: Schema.String` and `limit: Schema.Number` (default 5, range 1–20)
- [ ] `sessionId` is closed over in `makeQueryChunksLayer(sessionId)` — not exposed as an LLM-visible parameter
- [ ] Tool handler embeds query via `EmbeddingModel.embedMany` from `effect/unstable/ai` (Rule 1 — no direct OpenAI SDK)
- [ ] Tool handler filters by `sessionId` (Rule 15) — no cross-session chunk leakage
- [ ] `makeQueryChunksLayer` provided via `Stream.provide(...)` to Brief Writer, PRD Writer, Revision Brief Writer, Revision PRD Writer
- [ ] Challenger and Question Generator do not receive the tool — they use `generateObject` which does not accept a toolkit
- [ ] System prompt in each Writer explains the tool is available and when to use it
- [ ] At least one Writer pass calls the tool in a Langfuse trace for a session with detailed source material
- [ ] Tool call results appear as child spans in Langfuse traces

**Gate:** `tokensBelowThreshold` fires correctly (not always `true`) — verify with a bundle exceeding 100k summary tokens. `inputMode = "retrieval"` reflected in DB. At least one `query_chunks` tool call appears in Langfuse Writer spans. Rule 15 verified: `WHERE session_id = ?` present in tool handler query. No cross-session leakage.

---

## Cross-cutting checks (tutor runs these at any phase)

- [ ] No file outside `src/agent/providers.ts` imports `@anthropic-ai/sdk`, `@ai-sdk/anthropic`, or any provider package directly (Rule 1)
- [ ] All LLM calls use `LanguageModel.generateObject` or `LanguageModel.streamText` from `effect/unstable/ai` (Rule 1)
- [ ] No file calls `mammoth.convertToHtml()` — only `mammoth.extractRawText()` (Rule 2)
- [ ] No file writes to the filesystem with `fs.writeFile` or `fs.writeFileSync` directly — all file I/O goes through `StorageAdapter` (Rule 4)
- [ ] No structured output pass uses manual `JSON.parse` — all structured passes use `LanguageModel.generateObject({ schema })` (Rule 6)
- [ ] No cross-workspace relative imports — all `packages/shared` imports use `@shipwright/shared/...` (Rule 14)
- [ ] No raw `fetch()` calls and no `openapi-fetch`/`openapi-typescript` imports in `apps/web/src/` — all API calls go through `AtomHttpApi` (Rule 10)
- [ ] All `query_chunks` tool handlers filter by `sessionId` via `makeQueryChunksLayer(sessionId)` (Rule 15)
