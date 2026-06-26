# Project Description Agent — Build Sequence

> **Project:** Project Description Agent
> **Stack ref:** project_description_agent_stack_v1.2.md
> **Architecture:** pnpm workspaces monorepo — apps/api, apps/web, packages/shared

---

## Critical Path

```
Schema → Ingestion → XState design → Summarizer + Challenger →
Clarifying loop → Writer passes → Export + Revision → API wiring →
Monorepo → Evals → Effect rewrite → React SPA → RAG
```

Everything on the critical path is load-bearing. The CLI is cut.
Build in order. Resist the urge to set up the frontend before the agent loop works.

---

## Phase 0 — Scaffold (~1 day)

**Single project, single `package.json`.** No monorepo, no workspaces. The Effect
HTTP server and Vite frontend live in the same project. In development: Effect server
runs on port 3000, Vite dev server on port 5173. In production: Vite builds to
`dist/`, the Effect server serves it as static files.

> **Deviation (Phase 7):** The monolith is restructured into a pnpm workspaces
> monorepo at Phase 7. The Phase 0 structure below describes the starting point
> only. See Phase 7 for the target layout.

**Project structure (actual):**

```
src/
  server/     — Effect HttpApi server, endpoint definitions, handlers
  agent/      — XState machines, Vercel AI SDK passes, summarizer, challenger
  db/         — Drizzle schema, migrations, query functions
  storage/    — StorageAdapter Effect Context.Service + S3 implementation
  web/        — Vite + React frontend
  shared/     — schemas and types shared across layers
    domain/   — domain error classes
    schemas/  — Zod schemas (agent.ts, machine.ts), Effect schemas (api.ts)
    lib/      — utilities
```

- Docker Compose: Postgres + pgvector + rustfs (S3-compatible local storage)
- Langfuse: use Langfuse Cloud free tier during development; full self-hosted
  stack (Postgres + ClickHouse + Redis + S3) when needed — defer this complexity
- Drizzle schema — all tables including `vector(1536)` column on `chunks`
- Effect HttpApi server skeleton with endpoint stubs in `src/server/`
- `StorageAdapter` as Effect `Context.Service` in `src/storage/`
- Environment variable setup (`.env.example` committed, `.env` gitignored)

**End state:** nothing runs, but the project structure, data contract, and
type boundaries are established and won't need to change.

---

## Phase 1 — Document Ingestion (~3 days)

> Auth deferred — Better Auth + drizzle-orm v1 beta compatibility risk.
> Will be added when drizzle reaches stable 1.0. No auth layer in V1.

### 1a — File upload via presigned URLs

**Flow:**

```
FE → POST /api/sessions/upload-url  → BE returns { sessionId, presignedUrl, s3Key }
FE → PUT presignedUrl (direct to S3/rustfs, no BE in the middle)
FE → POST /api/sessions/:id/confirm-upload { s3Key }
BE → HeadObject(s3Key) — verify file actually exists before trusting FE
BE → returns 202 Accepted, XState machine starts async
```

- `POST /api/sessions/upload-url` — authenticated, validates file metadata
  (name, size, MIME type), generates presigned PUT URL (15 min TTL), creates
  session record in `pending` state
- FE uploads directly to S3/rustfs — no file bytes touch the Hono server
- `POST /api/sessions/:id/confirm-upload` — BE calls `HeadObject` to verify
  the object exists before firing `UPLOAD_COMPLETE` to the XState machine.
  Returns `202 Accepted` immediately — processing runs async.
- FE polls `GET /api/sessions/:id` for status updates
- Accepted formats: PDF, DOCX, plain text/Markdown, PNG/JPEG/WebP
- Reject uploads over 100MB at presigned URL generation time (no wasted upload)

**Why presigned URLs over multipart to Hono:**
File bytes never touch the server. No memory pressure, no timeout risk on large
files, no streaming plumbing. S3 handles the upload; Hono handles the logic.

**File type verification:**

- At URL generation time: validate MIME type from client metadata
- After `HeadObject` confirmation: `file-type` check on a small byte range from S3
  before handing to the parser — reject if MIME type does not match actual content

---

### 1b — Document parsing

- **PDF** — `unpdf`
- **DOCX** — `mammoth` via `extractRawText()` only, never `convertToHtml()`
- **Plain text / Markdown** — `fs/promises`
  Image support (PNG, JPEG, WebP via Claude Vision) — deferred to a later iteration.

---

### 1c — Chunking, embedding, storage

- Custom recursive character chunker with overlap and minimum chunk size guard
- Metadata tagging per chunk: `documentType`, `chunkIndex`, `sessionId`, `documentId`
- Embed chunks via `OpenAI text-embedding-3-small` through Vercel AI SDK `embedMany()`
- Store chunks in pgvector via Drizzle `vector()` column
- Store `tokenCount` on `documents` table (needed for Phase 2 threshold guard)
- **`p-queue` with `concurrency: 2`** wraps the full parse → chunk → embed → store pipeline per document. Prevents memory exhaustion under concurrent uploads. Module-level singleton in `src/agent/process-uploaded-documents.ts`.

**Zod schemas to define in `src/shared/schemas/documents.ts`:**

```ts
const DocumentTypeSchema = z.enum(["transcript", "prd_draft", "rfp", "notes", "image", "other"]);

const UploadRequestSchema = z.object({
  documentType: DocumentTypeSchema,
});

const ChunkMetaSchema = z.object({
  sourceDocument: z.string(),
  documentType: DocumentTypeSchema,
  chunkIndex: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
});
```

Validate the upload endpoint body with `@hono/zod-validator` using `UploadRequestSchema`.
Parse chunk metadata through `ChunkMetaSchema` before insertion — catches missing
fields before they silently enter the vector store.

**End state:** upload a PDF, DOCX, plain text, or Markdown file via presigned URL.
Chunks are queryable via pgvector semantic search.

---

## Phase 2 — XState Machine Design (~1 day, no code)

> Most important phase. Most likely to be skipped. Don't skip it.

Draw the full state diagram before writing any agent code. Define every
state, transition, guard, and event. The diagram is the architecture —
getting it wrong costs days of refactoring.

**States:**

```
idle → uploading → processing → summarizing → analyzing →
awaiting_answers → re_evaluating → generating → complete → revising
+ error (reachable from any state)
```

`summarizing` — added in Phase 4 design revision. The summarizer runs here, after
`processing` but before `USER_CONFIRM`. This is the correct placement for the
`tokensBelowThreshold` guard: by the time the user confirms, `documentSummaries[]`
is populated with real token counts, so the guard can evaluate whether all summaries
fit in context.

**Previous design (V1 deviation — in use until Phase 4 redesign):** `processing →
analyzing` on `USER_CONFIRM`, with summarization happening inside the analysis pipeline
after the guard fires. This means `documentSummaries[]` is empty when the guard runs
and always defaults to `context` mode. Acceptable for V1 corpus sizes. Correct fix is
the `summarizing` state above.

`revising` — reachable from `complete` when the user submits free-form revision
feedback. May loop through `awaiting_answers` again if new questions surface, then
back to `generating`. Each pass through `generating` increments `outputVersion`.

**Events:**

```
UPLOAD_COMPLETE, SUMMARIZATION_DONE, ANALYSIS_DONE, USER_ANSWERED,
ANSWERS_SUFFICIENT, ANSWERS_INSUFFICIENT, OUTPUT_READY, ERROR,
USER_CONFIRM, REVISION_REQUESTED
```

`UPLOAD_COMPLETE` — fired after `confirm-upload` succeeds. Transitions `idle → uploading`.
Server fires this immediately; the machine does not wait for the user.

`SUMMARIZATION_DONE` — fired when all per-document summaries are stored. Transitions
`summarizing → processing`. At this point `documentSummaries[]` is populated and the
guard can evaluate correctly.

`USER_CONFIRM` — explicit user confirmation required before analysis starts.
The machine does not transition from `processing` to `analyzing` automatically
after summarization completes. The user must confirm they are ready. This is a deliberate
HITL decision — the user can review what was uploaded and summarised before committing
to analysis. Fired by `POST /api/sessions/:id/confirm`.

`REVISION_REQUESTED` — fired when the user submits free-form feedback on the
generated outputs. Carries `{ feedback: string }`. Transitions `complete → revising`.

**Guards:**

```
tokensBelowThreshold  — decides context vs retrieval mode (on summary token counts)
                         evaluates context.documentSummaries[].tokenCount sum
                         only meaningful after SUMMARIZATION_DONE
roundLimitReached     — caps clarifying loop at 2 rounds
```

`hasEnoughContext` — removed. `tokensBelowThreshold` covers this role operating on
summary token counts rather than raw document token counts.

**Context shape** (what flows through the machine):

```
sessionId, documents[], documentSummaries[], questions[], answers[], round,
inputMode (context | retrieval), agentAnalysis, outputs{}
```

`documentSummaries[]` — populated when `SUMMARIZATION_DONE` fires. These are what
the Challenger and Writer passes consume — never raw document text. Each entry carries
`tokenCount` so the `tokensBelowThreshold` guard can correctly evaluate whether all
summaries fit in context at the `USER_CONFIRM` transition.

**Define the context shape as a Zod schema in `src/shared/schemas/machine.ts`:**

```ts
const MachineContextSchema = z.object({
  sessionId: z.string().uuid(),
  documents: z.array(
    z.object({
      id: z.string().uuid(),
      filename: z.string(),
      documentType: DocumentTypeSchema,
      tokenCount: z.number().int().positive(),
    }),
  ),
  documentSummaries: z.array(
    z.object({
      id: z.string().uuid(), // document_summaries.id
      documentId: z.string().uuid(),
      sourceDocument: z.string(), // documents.filename
      documentType: DocumentTypeSchema,
      content: z.string(), // final summary content
      tokenCount: z.number().int().positive(),
    }),
  ),
  questions: z.array(
    z.object({
      id: z.string().uuid(),
      text: z.string(),
      rationale: z.string(),
      sourceDocuments: z.array(z.string()),
    }),
  ),
  answers: z.array(
    z.object({
      questionId: z.string().uuid(),
      text: z.string(),
      round: z.number().int(),
    }),
  ),
  round: z.number().int().min(0).max(2),
  inputMode: z.enum(["context", "retrieval"]),
  agentAnalysis: z.unknown().nullable(),
  revisionFeedback: z.string().nullable(),
  outputVersion: z.number().int().min(1),
  outputs: z.object({
    projectBrief: z.string().optional(),
    implementationPrd: z.string().optional(),
  }),
});

export type MachineContext = z.infer<typeof MachineContextSchema>;
```

This schema does two things: it is the TypeScript type source of truth for the
machine context, and it validates the `xstateSnapshot` when rehydrating from
Postgres — catching snapshot corruption before it causes a silent bad state.

**End state:** a diagram you can walk a colleague through. The XState
implementation in Phase 4 is just translating this diagram into code.

---

## Phase 3 — Per-Document Summarization + Challenger (~3 days)

> **Design revision (11.06.2026):** Replaces the single-pass Extractor design.
> The agent never reads raw document text in one LLM call. Chunks from the DB are
> the primary read path. All analysis passes work from per-document summaries.

### 3a — Per-document summarization (map-reduce)

For each document in the session:

1. **Load chunks from DB** — query `chunks` table by `documentId`, ordered by `chunkIndex`.
2. **Map pass** — split chunks into batches (configurable, starting point: 20 chunks per
   batch). Each batch gets a summarization LLM call producing an intermediate summary.
   Each intermediate is stored as a row in `document_summaries` with
   `summaryType = 'map_intermediate'` and `batchIndex` set. If the document is small
   enough to fit in one call, skip directly to the reduce pass.
3. **Reduce pass** — summarize all intermediates into a single final summary. Stored as
   a new row with `summaryType = 'final'`. This is what all downstream passes consume.
4. **Re-summarization** creates new rows — old versions are retained. Query the latest
   final with `ORDER BY version DESC LIMIT 1`.

**Why a separate table and not a column on `documents`:**

- Map intermediates and the final are all rows in the same table — full visibility
  into the map-reduce tree for debugging and evals
- Re-summarization (e.g. after revision) creates a new row; history is never overwritten
- `tokenCount` per row lets the XState guard evaluate whether all finals fit in context
  without re-reading content
- Keeps the `documents` row narrow — no fat text blob on a frequently-scanned table

**New tables and enums (add to `src/db/schema.ts`, then `drizzle-kit push`):**

`document_summaries` — one row per summarization pass (intermediate or final):

```ts
export const documentSummaries = pgTable("document_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => agentSessions.id),
  sourceDocument: text("source_document").notNull(), // filename, denormalised for query convenience
  version: integer("version").notNull().default(1),
  summaryType: summaryTypeEnum("summary_type").notNull(),
  batchIndex: integer("batch_index"), // chunkIndex for map_intermediate rows
  content: text("content").notNull(), // prose summary
  tokenCount: integer("token_count").notNull(), // token count of content — used by XState guard
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

`summary_items` — normalised requirements/constraints/assumptions, one row per item:

```ts
export const summaryItems = pgTable("summary_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  summaryId: uuid("summary_id")
    .notNull()
    .references(() => documentSummaries.id, { onDelete: "cascade" }),
  itemType: summaryItemTypeEnum("item_type").notNull(), // requirement | constraint | assumption
  text: text("text").notNull(),
  sourceDocument: text("source_document").notNull(),
  confidence: confidenceLevelEnum("confidence").notNull(), // high | medium | low
  orderIndex: integer("order_index").notNull(), // preserves array order
});
```

New enums: `confidence_level ('high' | 'medium' | 'low')`, `summary_item_type ('requirement' | 'constraint' | 'assumption')`.

**Loading final summaries** uses a JOIN — `getFinalSummariesBySession` selects distinct-on `documentId` from `document_summaries`, left-joins `summary_items`, and reconstructs `ReconstructedSummary[]` in a helper function. `ReconstructedSummary` extends `DocumentSummary` with DB metadata (`id`, `documentId`, `sessionId`, `tokenCount`, `version`).

**AI SDK v6 pattern for summarization passes:**

```ts
import { generateText, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const { output } = await generateText({
  model: anthropic("claude-sonnet-4-5"),
  output: Output.object({ schema: DocumentSummarySchema }),
  system: summarizerSystemPrompt,
  messages: [{ role: "user", content: chunksAsText }],
});
```

Chunks go into `messages` as user content with `=== chunk N ===` headers.
The system prompt describes the task; the chunks are the input.

**Zod schemas to define in `src/shared/schemas/agent.ts`:**

```ts
const ItemWithSourceSchema = z.object({
  text: z.string(),
  sourceDocument: z.string(), // required — never optional
  confidence: z.enum(["high", "medium", "low"]),
});

const DocumentSummarySchema = z.object({
  sourceDocument: z.string(), // filename — required, never optional
  documentType: DocumentTypeSchema,
  summary: z.string(), // prose summary of the document's content
  requirements: z.array(ItemWithSourceSchema),
  constraints: z.array(ItemWithSourceSchema),
  assumptions: z.array(ItemWithSourceSchema),
});

export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;
```

**Summarization strategy — decision deferred, three options kept open:**

The implementation in `src/agent/summarizer.ts` should be written so the strategy
is swappable behind a common interface. Three viable options for V1+:

- **Map-reduce (default)** — batch chunks → parallel intermediate summaries →
  single reduce call. Parallelisable, simple. Can lose coherence at batch
  boundaries if a key idea spans two batches.

- **Hierarchical summarization** — summarise pairs of chunks recursively (like a
  tournament bracket) until one summary remains. Better coherence across boundaries
  than flat map-reduce. Moderate additional complexity.

- **Agentic with tools** — the model is given a `query_chunks(query: string)` tool
  and builds its understanding by issuing targeted queries to pgvector. Most flexible
  for sparse important information in long documents. Hardest to bound — the model
  decides how many tool calls to make.

> Note: with Gemini 2.5 Pro (1M context) already in the stack as an overflow model,
> very large single documents can bypass summarization entirely by routing there.
> The summarization strategy applies to the typical-case document size.

---

### 3b — Challenger pass (works from summaries, not raw text)

Once all per-document summaries are stored:

1. **Load final summaries** — query `document_summaries` where `session_id = ?` and
   `summary_type = 'final'`, ordered by `version DESC`, one per `document_id`.
   These are already in `documentSummaries[]` in XState context from the summarization pass.
2. **Challenger call** — pass all final summaries into a single LLM call. Each summary
   is labelled with its `sourceDocument` and `documentType`. The Challenger compares
   across summaries to find conflicts, gaps, and ambiguities.
3. **Output** — `GapReport` structured object persisted to `agentAnalysis` in XState context.

```ts
const ConflictSchema = z.object({
  description: z.string(),
  documentA: z.string(), // filename of first source
  documentB: z.string(), // filename of second source
});

const GapReportSchema = z.object({
  conflicts: z.array(ConflictSchema),
  gaps: z.array(
    z.object({
      description: z.string(),
      affectedArea: z.string(),
    }),
  ),
  ambiguities: z.array(
    z.object({
      description: z.string(),
      sourceDocument: z.string(),
    }),
  ),
});

export type GapReport = z.infer<typeof GapReportSchema>;
```

**Why summaries and not raw text:** The per-document summaries already capture
requirements, constraints, and assumptions attributed to their source. The Challenger
reasons across summaries — it does not re-read raw chunks. This keeps the call within
context limits and focuses reasoning on the synthesised content.

**Fallback for very large bundles:** If the combined size of all summaries exceeds the
context threshold, retrieve summaries by `documentType` priority (PRD draft and transcript
first). This fallback is handled by the XState `tokensBelowThreshold` guard, operating
on summary token counts rather than raw document token counts.

Run against the test corpus. Verify:

- Every `DocumentSummary` has a non-empty `sourceDocument`
- Every requirement/constraint/assumption has `sourceDocument`
- Challenger surfaces the planted contradiction (`documentA` and `documentB` both populated)
- Challenger surfaces at least one gap

**Do not proceed to Phase 4 until `document_summaries` rows with `summary_type = 'final'`
exist for all session documents and the Challenger surfaces the planted contradiction
from those summaries (not from raw text).**

---

## Phase 4 — The Clarifying Loop (~3 days)

### Pipeline split (design revision — Phase 4)

The analysis pipeline is split into two phases separated by a `USER_CONFIRM` gate:

**Phase A — Summarization** (automatic after confirm-upload):
1. `POST /api/sessions/:id/confirm` fires `UPLOAD_COMPLETE` and starts summarization async
2. `summarizeAllDocuments(sessionId)` runs — stores all `final` rows in `document_summaries`
3. Machine fires `SUMMARIZATION_DONE` → transitions `uploading → processing`
4. `documentSummaries[]` is loaded into XState context
5. Machine waits in `processing` for explicit user confirmation

**Phase B — Analysis** (triggered by user confirming they are ready):
1. User calls `POST /api/sessions/:id/confirm` again (or a dedicated second step)
2. `USER_CONFIRM` fires → `tokensBelowThreshold` guard evaluates `documentSummaries[].tokenCount`
3. Machine transitions `processing → analyzing`
4. Challenger + Question Generator run → `ANALYSIS_DONE` fires with questions
5. Machine suspends at `awaiting_answers`

**Why this split matters:** `tokensBelowThreshold` needs real summary token counts to
decide `context` vs `retrieval` mode. Those counts only exist after summarization completes.
Placing `USER_CONFIRM` after summarization gives the guard real data to evaluate.

**V1 deviation (current implementation):** Summarization runs inside the analysis pipeline
after the guard fires. `documentSummaries[]` is empty when the guard runs and always defaults
to `context` mode. Acceptable for V1 corpus sizes. The split above is the correct design
and should be implemented before large-bundle testing.

---

### Implement

- **`src/agent/question-generator.ts`** — `runQuestionGenerator(gapReport, summaries)` using
  `generateText` + `Output.object({ schema: ClarifyingQuestionsSchema })`
- **`src/agent/machine.ts`** — all states, transitions, guards, snapshot persistence wired
- **`src/agent/session-actor.ts`**:
  - `getOrRestoreActor(sessionId)` — loads from DB snapshot on server restart
  - `wireSnapshotPersistence(actor, sessionId)` — `actor.subscribe` persists on every transition (Rule 5)
  - `runAnalysisPipeline(sessionId)` — summarizer → challenger → question generator → `ANALYSIS_DONE`
  - `submitAnswers(sessionId, answers)` — persists answers, fires `USER_ANSWERED`, evaluates sufficiency
- **New route: `POST /api/sessions/:id/confirm`** — triggers pipeline, returns 202 immediately;
  client polls `GET /sessions/:id` for status and questions
- **`POST /api/sessions/:id/answers`** — validates payload, fires `USER_ANSWERED`
- **Stop condition**: `ANSWERS_SUFFICIENT` → `generating`, `ANSWERS_INSUFFICIENT` → loop,
  `roundLimitReached` → force to `generating` at round ≥ 2
- **Persist** questions to `questions` table before machine suspends;
  answers to `answers` table after `USER_ANSWERED`
- **Persist `xstateSnapshot`** via `updateAgentSessionSnapshot` on every transition

**Schemas (already implemented):**

- `ClarifyingQuestionSchema`, `ClarifyingQuestionsSchema` — `src/shared/schemas/agent.ts`
- `PostAgentSessionAnswersRequest` — `src/shared/schemas/api.ts`: `answers: Array<{ questionId: string, text: string }>`

**This is the core of the project. Expect iteration on the stop
condition logic — it's the hardest design problem in the codebase.**

## Phase 5 — Writer Passes (~2 days)

The Writer passes consume **per-document summaries** (from `documentSummaries[]` in
XState context) and the resolved answers from the clarifying loop — not raw document
text. This keeps both writer calls within context limits and grounds output in the
synthesised content.

- Implement **Writer (Brief)** pass: streaming Markdown, stakeholder-readable,
  5 minutes, no jargon, citations back to source documents (use `sourceDocument`
  fields from summaries for attribution)
- Implement **Writer (PRD)** pass: meta-prompt exercise — written for Claude Code
  or Cursor, not a human. Acceptance criteria, file/module hints, non-goals,
  edge cases, recommended stack. Different structure from a human PRD.
- Stream both outputs via `streamText` → `toDataStreamResponse()`
- Store completed outputs in `outputs` table with `version = 1`
- Wire prompt caching on document context (same context across all passes,
  pay the token cost once)

---

## Phase 5b — Output Export + Revision Loop (~1 day)

### Export

- New route: `GET /api/sessions/:id/output/:type/download-url`
  - `type` is `project_brief` or `implementation_prd`
  - Returns a presigned GET URL for the latest version of the output file from S3
  - Short TTL (e.g. 15 minutes) — the URL is for immediate download, not permanent
  - File bytes never pass through the server — client uploads directly to S3

**Zod schema for the route param:**

```ts
const OutputDownloadParamSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["project_brief", "implementation_prd"]),
});
```

### Revision loop

After outputs are generated, the user can submit free-form feedback and trigger
a re-generation. The machine does not restart — it loops within the existing session.

**XState additions:**

- New state: `revising` — reachable from `complete` via `REVISION_REQUESTED`
- `revising` may transition to `awaiting_answers` if new questions surface from
  the revision pass, then back to `generating`, then back to `complete`
- Each pass through `generating` increments `outputVersion` in context

**New route: `POST /api/sessions/:id/revise`**

```ts
const ReviseRequestSchema = z.object({
  feedback: z.string().min(1),
});
```

Fires `REVISION_REQUESTED` event carrying the feedback string. Returns `202`.

**Revision Writer pass:**

- Receives: existing outputs (both Brief and PRD) + free-form feedback +
  `documentSummaries[]` from context
- May re-query pgvector chunks if the feedback references specific areas
  (e.g. "the auth section needs more detail" — retrieve auth-related chunks)
- Regenerates both outputs; increments `version` on the `outputs` table rows

**Context additions (already added to `MachineContextSchema` in Phase 2):**

- `revisionFeedback: string | null` — the latest feedback string, cleared after generation
- `outputVersion: number` — starts at `1`, increments on each revision

---

## Phase 6 — Effect HttpApi wiring (~2 days)

- Wire XState machine to all session route handlers in `src/server/server.ts`
- Session rehydration: on request, load `xstateSnapshot` from Postgres, validate
  through `MachineContextSchema`, restore the XState machine
- All handlers are Effect generators — no Promise bridges
- Request/response schemas are `Schema.Class` definitions in `src/shared/schemas/api.ts`
  (Effect Schema, not Zod — Zod schemas are for LLM output validation only)
- OpenAPI schema auto-generated at `/openapi.json` by `HttpApiBuilder`

**Endpoint payload schemas in `src/shared/schemas/api.ts`:**

All payload fields are `Schema.Class` instances — Effect HttpApi validates them
automatically before the handler runs. A malformed UUID or missing field never
reaches the XState machine.

**End state:** a fully functional HTTP API. CLI and React SPA are
both just clients on top of this. The server exposes `/openapi.json` — the frontend
client is generated from it.

---

## Phase 7 — Monorepo Restructure (~1 day)

> **Deviation from original plan:** Phase 7 was a CLI. The CLI is cut — the React
> SPA (Phase 10) is the user-facing client. This phase converts the monolith into
> a pnpm workspaces monorepo to support independent frontend and backend packages
> and clean shared-type boundaries.

### Target structure

```
apps/
  api/          — everything currently in src/ (server, agent, db, storage)
    src/
      server/
      agent/
      db/
      storage/
    package.json
    tsconfig.json
  web/          — React SPA (new, built in Phase 10)
    src/
    package.json
    tsconfig.json
packages/
  shared/       — src/shared/ extracted here
    src/
      domain/
      schemas/
      lib/
    package.json
    tsconfig.json
docker-compose.yml   — stays at repo root
.env / .env.example  — stays at repo root
drizzle.config.ts    — stays at repo root (points into apps/api)
package.json         — workspace root, no src code
pnpm-workspace.yaml  — declares apps/* and packages/*
```

### What moves

- `src/server/`, `src/agent/`, `src/db/`, `src/storage/` → `apps/api/src/`
- `src/shared/` → `packages/shared/src/`
- All existing test gate scripts (`test-phase4-gate.ts`, `test-phase5-gate.ts`,
  `test-phase5b-gate.ts`) moved into `apps/api/src/agent/tests/` alongside the
  corpus test and unit tests. A dedicated `tests/gates/` folder was the plan;
  `src/agent/tests/` is the actual location — functionally equivalent.
- `src/config.ts` → `apps/api/src/config.ts`
- Root `package.json` becomes the workspace root — no direct source dependencies.
  All runtime dependencies move into `apps/api/package.json`.
  Shared types move into `packages/shared/package.json`.

### Import path changes

- All imports of `../../shared/...` in `apps/api` become `@shipwright/shared/...`
- `packages/shared` exports via `package.json` `exports` field:
  `"."`, `"./api"`, `"./schemas"`, `"./domain"`, `"./lib"`

### The `Api` definition moves to `packages/shared`

The `HttpApi` class (currently `src/server/api/api.ts`) is **not server code** — it
is a pure schema definition shared between the server and the client. It moves to
`packages/shared/src/api/` as part of this phase.

- `src/server/api/api.ts` → `packages/shared/src/api/index.ts`
- `apps/api` imports `Api` from `@shipwright/shared/api` to build `HttpApiBuilder`
- `apps/web` imports the same `Api` from `@shipwright/shared/api` to build `AtomHttpApi.Service`

This is the mechanism that replaces `openapi-typescript` code generation: both sides
reference the same runtime object, so request/response types are guaranteed in sync
with zero build steps.

### What does not move

- `docker-compose.yml`, `.env.example` — repo root
- `drizzle.config.ts` — `apps/api/` (deviation from plan; co-located with schema is better)
- Drizzle migrations output — `apps/api/src/db/out/`

### Why monorepo now

- `packages/shared` will be imported by both `apps/api` and `apps/web` —
  having it as a proper workspace package makes this a single source of truth
  with no copy-paste or symlink hacks
- `apps/web` gets its own dependency tree — no React/Vite pollution in the
  API package
- pnpm workspace protocol (`workspace:*`) ensures the shared package is always
  the local version, never accidentally resolved from npm

**Gate:** `pnpm -r build` passes from repo root. `pnpm --filter @shipwright/api start` starts the server on port 3000. All gate tests in `apps/api/tests/gates/` still pass.

---

## Phase 8 — Langfuse + Evals (~2 days)

> **Reordering note:** This phase runs after the monorepo restructure (Phase 7)
> and before the Effect rewrite (Phase 9). Reason: tracing is easier to wire
> into the clean Effect pipeline that Phase 9 produces than into Promise chains.
> Running evals here also gives a baseline to verify the rewrite doesn't regress
> output quality.

- Wire `@langfuse/vercel` — wraps Vercel AI SDK calls with trace/span context
- Note: if using Langfuse Cloud free tier (recommended for dev), just add API keys.
  Self-hosted requires Postgres + ClickHouse + Redis + S3 — defer until needed.
- Test corpus already built in Phase 3 (`docs/test_corpus/`). Use it here.
- Run **faithfulness eval**: no hallucinated requirements (LLM-as-judge)
- Run **completeness eval**: nothing important dropped (LLM-as-judge)
- Run **conflict detection eval**: contradiction between transcript and PRD
  is correctly surfaced (deterministic check)
- Verify clarifying loop stop condition fires at the right time

**Zod schema for LLM-as-judge responses in `packages/shared/src/schemas/evals.ts`:**

```ts
const EvalResultSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string(),
  pass: z.boolean(),
  citations: z.array(z.string()).optional(), // which parts of source supported score
});

const FaithfulnessEvalSchema = z.object({
  hallucinatedRequirements: z.array(
    z.object({
      text: z.string(),
      reason: z.string(), // why this was deemed hallucinated
    }),
  ),
  result: EvalResultSchema,
});

const ConflictDetectionEvalSchema = z.object({
  conflictsSurfaced: z.array(z.string()), // descriptions of found conflicts
  plantedConflictFound: z.boolean(), // deterministic check
  result: EvalResultSchema,
});
```

Parse every LLM-as-judge response through these schemas. An unparseable judge
response is a failed eval, not a passing one with a warning.

**Gate:** All 4/4 planted issues surfaced. Faithfulness eval passes (score ≥ 0.9).
Completeness eval passes. Conflict detection: `plantedConflictFound: true`.

---

## Phase 8b — Queue Port (~1 day)

> Runs after Phase 8 (Evals). All async work that currently fires from HTTP
> handlers gets routed through a `QueuePort` hexagonal port. Rule 16 enforces
> this at the architecture level.

### What to build

**1. Job union type** in `packages/shared/src/schemas/queue.ts`:

```ts
export type DocumentProcessingJob = { type: "DocumentProcessingJob"; sessionId: string }
export type SummarizationJob      = { type: "SummarizationJob";      sessionId: string }
export type AnalysisJob           = { type: "AnalysisJob";           sessionId: string }
export type GenerationJob         = { type: "GenerationJob";         sessionId: string; round: number }
export type RevisionJob           = { type: "RevisionJob";           sessionId: string; feedback: string }

export type Job =
  | DocumentProcessingJob
  | SummarizationJob
  | AnalysisJob
  | GenerationJob
  | RevisionJob
```

Each job carries `{ type, sessionId, ...payload }` — the minimum context needed
to execute the work and route the completion event back to XState.

**2. `QueuePort`** as `Context.Service` in `apps/api/src/queue/index.ts`:

```ts
export class QueuePort extends Context.Service<QueuePort>()(
  "shipwright/queue/QueuePort",
  {
    enqueue: <J extends Job>(job: J): Effect.Effect<void, QueueError> => ...,
    subscribe: <J extends Job>(
      type: J["type"],
      handler: (job: J) => Effect.Effect<void, never>
    ): Effect.Effect<void, never> => ...,
  }
) {}
```

**3. `InMemoryQueueLive`** in `apps/api/src/queue/in-memory.ts`:

Wraps the existing `p-queue` singleton. One `PQueue` instance per job type,
concurrency configurable. `subscribe` registers the handler; `enqueue` adds to
the relevant queue. `InMemoryQueueLive` is the `QueuePort.layer` used in V1.

**4. Job handlers** in `apps/api/src/queue/job-handlers.ts`:

Register one handler per job type. Each handler:
1. Executes the pipeline work (calling existing agent functions via `Effect.provide(runtime)`)
2. Calls `sendMachineEvent(sessionId, completionEvent)` on success
3. Calls `sendMachineEvent(sessionId, { type: "ERROR", ... })` on failure

| Job | Pipeline | XState completion event |
|---|---|---|
| `DocumentProcessingJob` | `processUploadedDocuments(sessionId)` | `PROCESSING_DONE` |
| `SummarizationJob` | `summarizeAllDocuments(sessionId)` | `SUMMARIZATION_DONE` |
| `AnalysisJob` | `runChallenger` + `runQuestionGenerator` | `ANALYSIS_DONE` |
| `GenerationJob` | `runWriterBrief` + `runWriterPrd` | `OUTPUT_READY` |
| `RevisionJob` | `runRevisionWriter(sessionId, feedback)` | `OUTPUT_READY` |

**5. Register `QueuePort.layer` in `runtime.ts`:**

```ts
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    StorageAdapter.layer,
    DatabaseService.layer,
    AnthropicClientLayer,
    OpenAiClientLayer,
    QueuePort.layer,   // ← add
  ),
  { memoMap: appMemoMap },
)
```

**6. Migrate `apps/api/src/server/handlers.ts`:**

Every handler that triggers async work:
- Remove direct `Effect.runForkWith` / `Effect.forkDaemon` calls
- Replace with `yield* QueuePort.enqueue({ type: "...", sessionId })`
- Return `202 Accepted` immediately

**7. Migrate `apps/api/src/agent/session-actor.ts`:**

XState actors that currently invoke agent pipelines directly:
- Replace inline agent calls with `QueuePort.enqueue(job)`
- The job handler fires `sendMachineEvent` back when done — XState advances

**Exemption:** `wireSnapshotPersistence` retains `Effect.runForkWith(services)`.
XState subscriber callbacks are synchronous — this is the only correct bridge
pattern. It is not async work initiated by an HTTP handler.

### Gate

```bash
# Only wireSnapshotPersistence should remain — everything else must be gone
grep -rn "Effect\.runFork\|forkDaemon" apps/api/src/server/ apps/api/src/agent/
# Expected: apps/api/src/agent/session-actor.ts (wireSnapshotPersistence only)

# All 202 routes must call QueuePort.enqueue — no inline agent calls
grep -rn "processUploadedDocuments\|summarizeAllDocuments\|runChallenger\|runWriterBrief" \
  apps/api/src/server/
# Expected: no output
```

All existing gate tests (`test:phase4`, corpus test) still pass.

---

## Phase 9 — Full Effect Rewrite (~2 days)

> **Reordering note:** This was Phase 9 in the original sequence. It now runs
> after Langfuse/Evals (Phase 8) and before the React SPA (Phase 10). The evals
> baseline from Phase 8 lets you verify the rewrite doesn't regress output quality.

Complete the Effect migration. Do not start this before Phase 8 gate passes.

### 1. `DatabaseService` — wrap all Drizzle queries

Define a `DatabaseService` as `Context.Service` wrapping all functions from
`apps/api/src/db/queries.ts`. Each query returns `Effect<T, DbError>` instead of
`Promise<T>`.

```ts
export class DatabaseService extends Context.Service<
  DatabaseService,
  {
    createAgentSession(data: InsertAgentSession): Effect.Effect<SelectAgentSession, DbError>;
    createDocument(data: InsertDocument): Effect.Effect<SelectDocument, DbError>;
    getDocumentById(id: string): Effect.Effect<SelectDocument, DbError | DocumentNotFoundError>;
    // ... all other queries
  }
>()("shipwright/db/DatabaseService") {
  static readonly layer = Layer.effect(
    DatabaseService,
    Effect.sync(() => {
      // implement using db from apps/api/src/db/index.ts
    }),
  );
}
```

Benefits: eliminates all `Effect.tryPromise(...)` wrappers in the pipeline,
enables test layers with mock DB (no real Postgres needed for unit tests).

### 2. Parsers + embedder as Effect services

- `parseDocument` → `Effect.fn` returning `Effect<ParseResult, ParseError>`
- `embedChunks` → `Effect.fn` returning `Effect<number[][], EmbedError>`
- Eliminates remaining `Effect.tryPromise` wrappers in `process-uploaded-documents.ts` and `parsers.ts`

### 3. Merge all layers in `runtime.ts`

```ts
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(StorageAdapter.layer, DatabaseService.layer, AnthropicService.layer),
  { memoMap: appMemoMap },
);
```

### 4. Delete legacy code

- Raw Promise query functions in `queries.ts` once fully superseded
- All remaining `Effect.tryPromise` wrappers that wrapped now-Effect functions
- Old loose async functions in `session-actor.ts`

**Note:** Phase 9 was completed before Phase 7 (Monorepo) and expanded in scope:
`@effect/ai-anthropic` + `@effect/ai-openai` replaced Vercel AI SDK entirely.
Rule 1 was updated to reflect this. See Phase 9 in `docs/progress.md`.

**Gate:** PASSED (25.06.2026). Zero `Effect.tryPromise` in `apps/api/src/agent/`
and `apps/api/src/db/` except `parsers.ts` (third-party Promise wrappers — acceptable).
Vercel AI SDK fully removed. Phase 4 gate test starts correctly.

---

## Fine-tuning phase (after Phase 11)

These items were raised in mentor review and deferred deliberately. Revisit
after the core pipeline is working and evals pass.

- **Streaming parse + chunk** — replace buffer-based parsing with stream-based parsing. Pipe the S3 download stream directly into the parser. Reduces memory pressure for large files and concurrent users. Requires verifying `unpdf` and `mammoth` stream support.
- **Persistent processing queue** — `p-queue` (in-process, concurrency: 2) is already in place for V1. Upgrade to `pg-boss` (uses existing Postgres) or `BullMQ` (needs Redis) when job durability across server restarts is needed.
- **`embedMany` batching** — `embedMany` has a request size limit. For documents producing many chunks, implement batching before calling `embedMany`.
- **Document cleanup job** — background job to delete orphaned documents (no linked session), their chunks, and their S3 objects. Prevents storage accumulation from incomplete or abandoned sessions.
- **Chunk metadata enrichment** — DONE in Phase 1. `locationMeta: jsonb` column on `chunks` table typed as `LocationMeta | null`: `{ pageNumber?: number, headingPath?: string, charOffset?: number }`. Chunker returns `{ content: string, locationMeta: LocationMeta }[]`. Parsers emit location hints during parsing.
- **SSE for status updates** — replace `GET /api/sessions/:id` polling with Server-Sent Events via `POST /api/sessions/:id/stream` when building the React SPA.
- **Semantic chunking** — split at meaning boundaries rather than character count for better retrieval quality in Phase 11.
- **Hybrid search** — add BM25 full-text search alongside pgvector cosine similarity and rerank results. Better precision for exact term lookups. Useful after Phase 11a is working.
- **`query_chunks` call frequency tuning** — after Phase 11b is live, review Langfuse traces for passes that never call the tool despite the feature being available. Adjust system prompts to make retrieval opt-in vs opt-out explicit.

## Phase 10 — React SPA (after Phase 9)

> Only start this after the backend is solid, evals pass, and Phase 9 Effect rewrite is complete.
> The UI is a presentation layer over something that already works.

- Vite + React setup in `apps/web` (already scaffolded in Phase 7 monorepo)
- TanStack Router — three routes: `/`, `/sessions/:id/questions`, `/sessions/:id/output`
- **`AtomHttpApi.Service`** — built from `Api` imported from `@shipwright/shared/api`.
  No code generation, no OpenAPI file. Declare once in `apps/web/src/store/api.ts`:

  ```ts
  import { AtomHttpApi } from "effect/unstable/reactivity"
  import { Api } from "@shipwright/shared/api"
  import { BrowserHttpClient } from "@effect/platform-browser"

  export class ShipwrightApi extends ... {
    static readonly instance = AtomHttpApi.Service<ShipwrightApi>()(
      "shipwright/Api",
      { api: Api, httpClient: BrowserHttpClient.layerFetch, baseUrl: "http://localhost:3000" }
    )
  }
  ```

- **`@effect/atom-react`** — all async server state lives in atoms, not TanStack Query.
  `useAtomValue` / `useAtom` / `useAtomSuspense` from `@effect/atom-react` are the
  only React hooks needed for data fetching:

  - Queries: `ShipwrightApi.instance.query(group, endpoint, { reactivityKeys, timeToLive })`
  - Mutations: `ShipwrightApi.instance.mutation(group, endpoint)` → write to trigger
  - Polling while processing: `Atom.withRefresh(sessionAtom, "2 seconds")` while
    `status !== "awaiting_answers"`
  - Cache invalidation after mutation: `reactivityKeys: ["session", id]`

- **`RegistryProvider`** from `@effect/atom-react` wraps the app root — provides the
  `AtomRegistry` that runs all atom effects.
- shadcn/ui + Tailwind for layout and form controls
- Standard question/answer form (not a chat UI — no assistant-ui needed)
- Dual-panel Markdown viewer for Brief and PRD outputs
- Download buttons wired to `GET /api/sessions/:id/output/:type/download-url`
- CORS enabled on `apps/api` for `http://localhost:5173` (deferred from Phase 6)
- `@shipwright/shared` imported directly — no duplicated type definitions in the frontend

**Gate:** Full end-to-end run in the browser — upload files, answer questions,
view both outputs, download Markdown files. Zero raw `fetch()` calls in `apps/web/src/`.
Zero TanStack Query imports in `apps/web/src/`.

---

## Phase 11 — RAG: Retrieval Mode + Agentic Chunks (~2 days)

> **New phase** — not in the original build sequence. Addresses the two known V1
> deviations: the `tokensBelowThreshold` guard always fires `true`, and the
> retrieval path is never actually executed.

### 11a — Activate retrieval mode (fix the V1 deviation)

The `tokensBelowThreshold` XState guard exists but always defaults to `context`
mode because `documentSummaries[]` is empty when it runs. The fix requires
implementing the `summarizing` state described in Phase 2/4:

1. Add the `summarizing` XState state (currently deferred — see Phase 4 V1 deviation note)
2. `POST /api/sessions/:id/confirm` transitions to `summarizing` and starts
   `summarizeAllDocuments` before waiting for `USER_CONFIRM`
3. `SUMMARIZATION_DONE` populates `documentSummaries[]` in context, transitions
   to `processing`, and waits
4. `POST /api/sessions/:id/confirm` (second call, or a new `POST /api/sessions/:id/ready`)
   fires `USER_CONFIRM` — guard now has real token counts to evaluate
5. Implement the retrieval path: when `tokensBelowThreshold` returns `false`,
   retrieve the top-k most relevant summaries from pgvector by cosine similarity
   rather than stuffing all summaries into context

**Retrieval query pattern:**

```ts
// In context mode: pass all documentSummaries[] from XState context
// In retrieval mode: query pgvector for top-k summaries by relevance
const relevantSummaries = await db
  .select()
  .from(documentSummaries)
  .where(eq(documentSummaries.sessionId, sessionId))
  .orderBy(sql`embedding <=> ${queryEmbedding}`)
  .limit(TOP_K);
```

### 11b — Agentic RAG via `query_chunks` tool

Add a `query_chunks(query: string, limit?: number)` Vercel AI SDK `tool()` that
the LLM can call during analysis and writing passes to retrieve relevant chunks
from pgvector on demand.

```ts
import { tool } from "ai";

export const queryChunksTool = (sessionId: string) =>
  tool({
    description:
      "Retrieve relevant document chunks by semantic similarity. Use when you need more detail on a specific area not covered in the summaries.",
    parameters: z.object({
      query: z.string().describe("The search query — a specific question or topic"),
      limit: z.number().int().min(1).max(20).default(5).optional(),
    }),
    execute: async ({ query, limit = 5 }) => {
      const embedding = await embed(query);
      return retrieveChunks(sessionId, embedding, limit);
    },
  });
```

**Which passes get the tool:**

| Pass | Tool available | Notes |
|---|---|---|
| Challenger | Yes | Useful for resolving ambiguities between summaries |
| Question Generator | Yes | Can pull supporting detail for question rationale |
| Writer (Brief) | Yes | Can verify a claim against source chunks |
| Writer (PRD) | Yes | Useful for detailed constraint verification |
| Revision Writer | **Primary use case** | "The auth section needs more detail" → targeted chunk retrieval |

The tool is wired and available to all passes. Individual passes are not
required to call it — the model decides when a targeted lookup is needed.
Monitor tool call frequency in Langfuse traces; if a pass never calls it,
review the system prompt to ensure the model knows it's available.

**Gate:** Retrieval mode activates on a test bundle where total summary tokens
exceed the threshold. Agentic tool calls appear in at least one Langfuse trace.
`tokensBelowThreshold` guard correctly evaluates real token counts (not always `true`).

---

## Phase 12 — Auth: Better Auth (~2 days)

> **Prerequisite:** `better-auth/better-auth#9489` (Drizzle Relations v2 support)
> merged into better-auth's `next` branch.
>
> A preview build exists at `pkg.pr.new/better-auth@9489` and
> `pkg.pr.new/@better-auth/drizzle-adapter@9489` — do not use in production until
> the PR merges; it changes as the PR is revised.
>
> Do not start this phase until the prerequisite is met.

### What to build

**1. Install dependencies:**

```bash
pnpm --filter @shipwright/api add better-auth @better-auth/drizzle-adapter
```

**2. Schema additions** (`apps/api/src/db/schema.ts`):

Better Auth manages `users` and `sessions` tables. Add them via the drizzle
adapter's schema generation (or manually — same result):

```ts
// users table — Better Auth managed
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})

// sessions table — Better Auth managed (separate from agent_sessions)
export const authSessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
})
```

Add `userId` FK to `agent_sessions`:

```ts
export const agentSessions = pgTable("agent_sessions", {
  // ... existing columns
  userId: text("user_id").references(() => users.id), // nullable first
})
```

**3. Better Auth config** (`apps/api/src/auth/auth.ts`):

```ts
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { db } from "../db/index.ts"
import { schema } from "../db/schema.ts"

export const auth = betterAuth({
  database: drizzleAdapter(db, { schema }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
})
```

**4. Mount auth routes** in `apps/api/src/server/server.ts`:

Better Auth exposes `auth.handler: (Request) => Promise<Response>`.
Mount as a catch-all at `/api/auth/*` in the `HttpRouter` before `HttpApiBuilder`:

```ts
const authRoutes = HttpRouter.empty.pipe(
  HttpRouter.all("/api/auth/*", (req) =>
    Effect.promise(() => auth.handler(req.source))
  )
)
```

**5. `CurrentUser` middleware** (`apps/api/src/server/middleware.ts`):

```ts
export class CurrentUser extends Context.Tag("shipwright/CurrentUser")<
  CurrentUser,
  { id: string; email: string; name: string }
>() {}

export const AuthMiddleware = HttpApiMiddleware.make(CurrentUser, {
  // validate session cookie via auth.api.getSession
  // yield CurrentUser on success, HttpApiError.unauthorized on failure
})
```

**6. Protect session routes:**

Apply `AuthMiddleware` to the `SessionsApiGroup` in `packages/shared/src/api/api.ts`.
Handlers that access `CurrentUser` won't compile without the middleware present.

**7. Row-level isolation** — update `DatabaseService` query methods:

Every method touching `agent_sessions`, `documents`, `chunks`, `outputs` gains a
`userId` parameter and a `WHERE user_id = userId` filter. No query may return
another user's data. Pattern:

```ts
getSessionById(id: string, userId: string): Effect.Effect<SelectAgentSession, DbError | SessionNotFoundError>
// → WHERE id = $id AND user_id = $userId
```

**8. `.env.example` additions:**

```
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
BETTER_AUTH_SECRET=   # random 32-byte secret for session signing
BETTER_AUTH_URL=      # e.g. http://localhost:3000
```

**9. Run migrations:**

```bash
pnpm --filter @shipwright/api db:push
```

### Gate

```
Authenticated user completes full E2E flow:
  upload files → confirm → answer questions → view outputs → download

Unauthenticated request to any /api/sessions/* → 401 Unauthorized

User isolation:
  user A creates session S
  user B calls GET /api/sessions/S → 404 (not 403 — do not leak existence)

pnpm --filter @shipwright/api test:phase4 still passes
```

---

## Open questions to resolve during build

- Exact token threshold for context vs retrieval mode (tune empirically in Phase 3)
- Whether one clarification round is enough or two are needed (tune in Phase 4)
- Chunking strategy: chunk size, overlap, and minimum chunk size (tune in Phase 1 against retrieval quality)
- Whether `xstateSnapshot` serialisation covers all edge cases or needs custom reducers
- Minimum chunk size threshold — short paragraphs produce low-quality embeddings; merge or discard chunks below a minimum length

---
