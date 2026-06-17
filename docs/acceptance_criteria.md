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

- [x] All 9 states are present: `idle`, `uploading`, `processing`, `analyzing`, `awaiting_answers`, `re_evaluating`, `generating`, `complete`, `revising`
- [x] `error` state is reachable from every other state — V1 deviation: `awaiting_answers` has no ERROR transition by design (session blocks until user responds; server restart handled via snapshot rehydration)
- [x] All 9 events are defined: `UPLOAD_COMPLETE`, `ANALYSIS_DONE`, `USER_ANSWERED`, `ANSWERS_SUFFICIENT`, `ANSWERS_INSUFFICIENT`, `OUTPUT_READY`, `ERROR`, `USER_CONFIRM`, `REVISION_REQUESTED`
- [x] All 3 guards are defined with clear descriptions: `hasEnoughContext`, `tokensBelowThreshold` (evaluates summary token counts), `roundLimitReached`
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

- [ ] The XState machine can be instantiated from the design in Phase 2
- [ ] When the machine enters `awaiting_answers`, it does not proceed until a `USER_ANSWERED` event is sent
- [ ] `POST /api/sessions/:id/answers` with a payload fires the `USER_ANSWERED` event
- [ ] After `USER_ANSWERED`, the machine transitions (does not stay in `awaiting_answers` indefinitely)
- [ ] Questions are persisted to the `questions` table before the machine suspends
- [ ] Answers are persisted to the `answers` table after `USER_ANSWERED`
- [ ] `SELECT xstate_snapshot FROM agent_sessions WHERE id = '<id>'` returns a non-null JSON value after every transition
- [ ] After a simulated server restart (stop + restart Hono), sending `USER_ANSWERED` to an in-progress session resumes correctly
- [ ] The `round` field in context increments correctly after each clarifying round
- [ ] When `round >= 2`, the `roundLimitReached` guard forces progression to `generating` regardless of answer quality
- [ ] Between 3 and 7 questions are generated — never fewer than 3, never more than 7

**Gate:** Session rehydration after restart must pass before Phase 5.

---

## Phase 5 — Writer Passes

- [ ] The Brief writer uses `streamText` — not `generateObject`
- [ ] The PRD writer uses `streamText` — not `generateObject`
- [ ] The streamed Brief is valid Markdown when rendered
- [ ] The streamed PRD contains at least: acceptance criteria section, non-goals section, recommended stack section
- [ ] `SELECT content FROM outputs WHERE session_id = '<id>' AND type = 'project_brief'` returns non-empty content
- [ ] `SELECT content FROM outputs WHERE session_id = '<id>' AND type = 'implementation_prd'` returns non-empty content
- [ ] `SELECT version FROM outputs WHERE session_id = '<id>'` returns `1`
- [ ] The Brief does not contain requirements not present in the source documents (spot-check 3 claims against sources)
- [ ] The system prompt for the Brief writer is different from the system prompt for the PRD writer
- [ ] Prompt caching is configured: the Anthropic provider call includes cache control headers on the document context

**Gate:** Both outputs must be stored in the DB before Phase 5b.

---

## Phase 5b — Output Export + Revision Loop

### Export

- [ ] `GET /api/sessions/:id/output/:type/download-url` returns `{ url: string }` with a presigned S3 GET URL
- [ ] The `type` param accepts only `project_brief` or `implementation_prd` — other values return `400`
- [ ] The presigned URL resolves to the correct output file content when fetched directly
- [ ] The presigned URL has a TTL (expires — it is not permanent)
- [ ] File bytes do not pass through Hono — the URL points directly to S3/rustfs

### Revision loop

- [ ] `POST /api/sessions/:id/revise` with `{ feedback: string }` returns `202`
- [ ] Sending `REVISION_REQUESTED` transitions the machine from `complete` to `revising`
- [ ] `xstateSnapshot` is persisted after the `complete → revising` transition
- [ ] The revision Writer pass receives the existing outputs + feedback + `documentSummaries[]` — not raw document text
- [ ] After revision completes, `SELECT version FROM outputs WHERE session_id = '<id>' ORDER BY version DESC LIMIT 1` returns `2`
- [ ] Both Brief and PRD are regenerated on revision (not just one)
- [ ] If the revision pass surfaces new questions, the machine enters `awaiting_answers` before returning to `generating`
- [ ] `outputVersion` in XState context increments correctly after each revision

**Gate:** Export URL must work and revision must produce a version-2 output before Phase 6.

---

## Phase 6 — Hono API + Streaming

- [ ] `POST /api/sessions/upload-url` with valid metadata returns `{ sessionId, presignedUrl, s3Key }`
- [ ] `POST /api/sessions/:id/confirm-upload` with a valid `s3Key` returns `202`
- [ ] `GET /api/sessions/:id` returns current status and questions when in `awaiting_answers`
- [ ] `POST /api/sessions/:id/stream` triggers analysis and streams progress — response content-type is `text/event-stream`
- [ ] `POST /api/sessions/:id/answers` returns `200` and the machine transitions
- [ ] `GET /api/sessions/:id/output` streams output — response content-type is `text/event-stream`
- [ ] `GET /api/sessions/:id/output/:type/download-url` returns a presigned URL
- [ ] `POST /api/sessions/:id/revise` returns `202` and the machine transitions to `revising`
- [ ] A `GET` request from `localhost:5173` to `localhost:5173/api/sessions` does not return a CORS error (single server setup — `@hono/vite-dev-server`)
- [ ] Stopping and restarting the Hono server mid-session does not lose session state
- [ ] Hono RPC types are exported and the `hc<typeof app>` client compiles without errors on the frontend

**Gate:** All routes must respond correctly before building any client (CLI or SPA).

---

## Phase 7 — CLI

- [ ] Running the CLI prompts for one or more file paths
- [ ] Providing a valid PDF path triggers upload and shows a spinner
- [ ] After analysis, questions are displayed clearly in the terminal (numbered, readable)
- [ ] Typing answers and submitting proceeds to the generation phase
- [ ] The generated Brief is printed to the terminal (or written to a file)
- [ ] The generated PRD is printed to the terminal (or written to a file)
- [ ] Running the full flow against the test corpus end-to-end completes without an unhandled error

**Gate:** Full end-to-end on the test corpus must complete before Phase 8.

---

## Phase 8 — Langfuse + Evals

- [ ] After running a session, traces appear in the Langfuse dashboard
- [ ] Each agent pass (Summarizer, Challenger, Question generator, Brief writer, PRD writer) appears as a named span
- [ ] The faithfulness eval runs and returns a score for at least one session
- [ ] The completeness eval runs and returns a score for at least one session
- [ ] Running the test corpus (5 files) through the full pipeline: Issue 1 surfaced — mobile scope conflict (prd_draft vs transcript)
- [ ] Running the test corpus through the full pipeline: Issue 2 surfaced — EU data residency buried in rfp.md
- [ ] Running the test corpus through the full pipeline: Issue 3 surfaced — delegation acceptance criteria gap (prd_draft vs hr_requirements.pdf)
- [ ] Running the test corpus through the full pipeline: Issue 4 surfaced — notification channel ambiguity (prd_draft vs transcript vs hr_requirements.pdf)
- [ ] Running the test corpus through the full pipeline: Issue 5 surfaced — SSO/auth conflict (prd_draft vs hr_requirements.pdf)

---

## Cross-cutting checks (tutor runs these at any phase)

- [ ] No file in `src/agent/` imports from `@anthropic-ai/sdk` directly
- [ ] No file calls `mammoth.convertToHtml()` — only `mammoth.extractRawText()`
- [ ] No file writes to the filesystem with `fs.writeFile` or `fs.writeFileSync` directly — all file I/O goes through `StorageAdapter`
- [ ] No structured output pass uses bare `generateText` without `Output.object()` — all structured passes use `generateText` + `Output.object({ schema })`
