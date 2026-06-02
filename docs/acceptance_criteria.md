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

- [ ] `npm run dev` starts the Hono server on port 3000 without errors
- [ ] `npm run dev:web` starts the Vite dev server on port 5173 without errors
- [ ] `drizzle-kit push` runs without errors — all tables created in Postgres
- [ ] `SELECT * FROM sessions LIMIT 1` returns an empty result (not an error)
- [ ] pgvector extension is enabled: `SELECT * FROM pg_extension WHERE extname = 'vector'` returns a row
- [ ] rustfs is reachable: a test upload via `@aws-sdk/client-s3` succeeds
- [ ] `.env.example` lists every required environment variable with a description
- [ ] `.env` is gitignored

**Gate:** Do not start Phase 1 until the DB, vector extension, and storage are all confirmed reachable.

---

## Phase 1 — Document Ingestion

- [ ] `POST /api/sessions` with a multipart PDF returns `200` with a `sessionId`
- [ ] `POST /api/sessions` with a DOCX file returns `200` with a `sessionId`
- [ ] `POST /api/sessions` with a `.txt` file returns `200` with a `sessionId`
- [ ] After upload, `SELECT count(*) FROM chunks WHERE session_id = '<id>'` returns > 0
- [ ] Every row in `chunks` has a non-null `embedding` column
- [ ] Every row in `chunks` has non-null `source_document`, `document_type`, `chunk_index`, `session_id`
- [ ] `SELECT token_count FROM documents WHERE session_id = '<id>'` returns a positive integer
- [ ] The uploaded file is retrievable via `StorageAdapter.download()` — not via `fs.readFile` directly
- [ ] A semantic query against pgvector for a term present in the uploaded document returns that document's chunks in the top results
- [ ] A semantic query for a term NOT in the document does not return that document's chunks at the top

**Gate:** Do not start Phase 2 until uploads, chunking, embedding, and retrieval all pass.

---

## Phase 2 — XState Machine Design

> This phase produces a diagram, not code. The tutor reviews the diagram.

- [ ] All 8 states are present: `idle`, `uploading`, `processing`, `analyzing`, `awaiting_answers`, `re_evaluating`, `generating`, `complete`
- [ ] `error` state is reachable from every other state
- [ ] All 7 events are defined: `UPLOAD_COMPLETE`, `ANALYSIS_DONE`, `USER_ANSWERED`, `ANSWERS_SUFFICIENT`, `ANSWERS_INSUFFICIENT`, `OUTPUT_READY`, `ERROR`
- [ ] All 3 guards are defined with clear descriptions: `hasEnoughContext`, `tokensBelowThreshold`, `roundLimitReached`
- [ ] Context shape is fully defined: `sessionId`, `documents[]`, `questions[]`, `answers[]`, `round`, `inputMode`, `agentAnalysis`, `outputs{}`
- [ ] The diagram shows `awaiting_answers` as a suspend point (waits for external `USER_ANSWERED` event)
- [ ] The diagram shows the loop: `re_evaluating` → `awaiting_answers` (when `ANSWERS_INSUFFICIENT` and round < limit) or → `generating` (when `ANSWERS_SUFFICIENT`)
- [ ] The diagram shows `roundLimitReached` guard forcing progression to `generating` even if answers are insufficient

**Gate:** Do not write XState code until the diagram passes. The code is a translation of the diagram.

---

## Phase 3 — Single Agent Pass

- [ ] `generateObject` is used for the Extractor pass — not `generateText`
- [ ] The Extractor Zod schema has a `sourceDocument` field on every item in the requirements array
- [ ] Running the Extractor against the test corpus returns zero requirements without a `sourceDocument`
- [ ] Running the Extractor against the test corpus identifies at least 3 distinct requirements
- [ ] `generateObject` is used for the Challenger pass — not `generateText`
- [ ] The Challenger Zod schema has `documentA` and `documentB` fields on conflicts
- [ ] Running the Challenger against the test corpus returns at least one conflict (the planted contradiction)
- [ ] Running the Challenger against the test corpus returns at least one gap
- [ ] The Anthropic SDK (`@anthropic-ai/sdk`) is NOT imported anywhere in the agent passes — only `@ai-sdk/anthropic` is used as a provider
- [ ] The system prompt for the Extractor is different from the system prompt for the Challenger

**Gate:** Do not start Phase 4 until the Extractor identifies the planted missing acceptance criterion and the Challenger surfaces the planted contradiction.

---

## Phase 4 — The Clarifying Loop

- [ ] The XState machine can be instantiated from the design in Phase 2
- [ ] When the machine enters `awaiting_answers`, it does not proceed until a `USER_ANSWERED` event is sent
- [ ] `POST /api/sessions/:id/answers` with a payload fires the `USER_ANSWERED` event
- [ ] After `USER_ANSWERED`, the machine transitions (does not stay in `awaiting_answers` indefinitely)
- [ ] Questions are persisted to the `questions` table before the machine suspends
- [ ] Answers are persisted to the `answers` table after `USER_ANSWERED`
- [ ] `SELECT xstate_snapshot FROM sessions WHERE id = '<id>'` returns a non-null JSON value after every transition
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

**Gate:** Both outputs must be stored in the DB before Phase 6.

---

## Phase 6 — Hono API + Streaming

- [ ] `POST /api/sessions` returns `{ sessionId: string }`
- [ ] `GET /api/sessions/:id` returns current status and questions when in `awaiting_answers`
- [ ] `POST /api/sessions/:id/stream` triggers analysis and streams progress — response content-type is `text/event-stream`
- [ ] `POST /api/sessions/:id/answers` returns `200` and the machine transitions
- [ ] `GET /api/sessions/:id/output` streams output — response content-type is `text/event-stream`
- [ ] A `GET` request from `localhost:5173` to `localhost:3000/api/sessions` does not return a CORS error
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
- [ ] Each agent pass (Extractor, Challenger, Question generator, Brief writer, PRD writer) appears as a named span
- [ ] The faithfulness eval runs and returns a score for at least one session
- [ ] The completeness eval runs and returns a score for at least one session
- [ ] Running the test corpus through the full pipeline: the Challenger surfaces the planted contradiction between the transcript and the PRD draft
- [ ] Running the test corpus through the full pipeline: the buried RFP constraint appears in the Extractor output or is flagged as a gap by the Challenger
- [ ] Running the test corpus through the full pipeline: the missing acceptance criterion is surfaced as a gap
- [ ] The clarifying loop asks about the ambiguous notification requirement

---

## Cross-cutting checks (tutor runs these at any phase)

- [ ] No file in `src/agent/` imports from `@anthropic-ai/sdk` directly
- [ ] No file calls `mammoth.convertToHtml()` — only `mammoth.extractRawText()`
- [ ] No file writes to the filesystem with `fs.writeFile` or `fs.writeFileSync` directly — all file I/O goes through `StorageAdapter`
- [ ] No LLM call uses `generateText` where `generateObject` is appropriate (structured output passes)
- [ ] No LLM call uses `generateText` where `generateObject` is appropriate (structured output passes)
