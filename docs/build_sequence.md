# Project Description Agent — Build Sequence

> **Project:** Project Description Agent
> **Stack ref:** project_description_agent_stack_v1.2.md
> **Architecture:** monolith — single project, single package.json

---

## Critical Path

```
Schema → Ingestion → XState design → Extractor pass →
Clarifying loop → Writer passes → API wiring → CLI → Evals
```

Everything on the critical path is load-bearing. The React SPA is not.
Build in order. Resist the urge to set up the frontend before the agent loop works.

---

## Phase 0 — Scaffold (~1 day)

**Single project, single `package.json`.** No monorepo, no workspaces. Hono and
Vite live in the same project — shared types require no ceremony, just import them.
In development: Hono runs on port 3000, Vite dev server on port 5173. In production:
Vite builds to `dist/`, Hono serves it as static files.

**Project structure:**
```
src/
  api/        — Hono server, routes, middleware
  agent/      — XState machines, Vercel AI SDK passes
  db/         — Drizzle schema, migrations
  storage/    — StorageAdapter interface + implementations
  web/        — Vite + React frontend (empty for now)
  shared/     — types shared between api and web
```

- Docker Compose: Postgres + pgvector + rustfs (S3-compatible local storage)
- Langfuse: use Langfuse Cloud free tier during development; full self-hosted
  stack (Postgres + ClickHouse + Redis + S3) when needed — defer this complexity
- Drizzle schema — all tables including `vector(1536)` column on `chunks`
- Hono skeleton with route stubs + Hono RPC types exported from `src/api/`
- `StorageAdapter` interface defined in `src/storage/` with `rustfs` implementation
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
const DocumentTypeSchema = z.enum(['transcript', 'prd_draft', 'rfp', 'notes', 'image', 'other'])

const UploadRequestSchema = z.object({
  documentType: DocumentTypeSchema,
})

const ChunkMetaSchema = z.object({
  sourceDocument: z.string(),
  documentType: DocumentTypeSchema,
  chunkIndex: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
})
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
idle → uploading → processing → analyzing →
awaiting_answers → re_evaluating → generating → complete
+ error (reachable from any state)
```

**Events:**
```
UPLOAD_COMPLETE, ANALYSIS_DONE, USER_ANSWERED,
ANSWERS_SUFFICIENT, ANSWERS_INSUFFICIENT, OUTPUT_READY, ERROR,
USER_CONFIRM
```

`USER_CONFIRM` — explicit user confirmation required before analysis starts.
The machine does not transition from `processing` to `analyzing` automatically
after upload completes. The user must confirm they are ready. This is a deliberate
HITL decision — the user can review what was uploaded before committing to analysis.

**Guards:**
```
hasEnoughContext       — tokenCount below threshold → stuff context directly
tokensBelowThreshold  — decides context vs retrieval mode
roundLimitReached     — caps clarifying loop at 2 rounds
```

**Context shape** (what flows through the machine):
```
sessionId, documents[], questions[], answers[], round,
inputMode (context | retrieval), agentAnalysis, outputs{}
```

**Define the context shape as a Zod schema in `src/shared/schemas/machine.ts`:**
```ts
const MachineContextSchema = z.object({
  sessionId: z.string().uuid(),
  documents: z.array(z.object({
    id: z.string().uuid(),
    filename: z.string(),
    documentType: DocumentTypeSchema,
    tokenCount: z.number().int().positive(),
  })),
  questions: z.array(z.object({
    id: z.string().uuid(),
    text: z.string(),
    rationale: z.string(),
    sourceDocuments: z.array(z.string()),
  })),
  answers: z.array(z.object({
    questionId: z.string().uuid(),
    text: z.string(),
    round: z.number().int(),
  })),
  round: z.number().int().min(0).max(2),
  inputMode: z.enum(['context', 'retrieval']),
  agentAnalysis: z.unknown().nullable(),
  outputs: z.object({
    projectBrief: z.string().optional(),
    implementationPrd: z.string().optional(),
  }),
})

export type MachineContext = z.infer<typeof MachineContextSchema>
```
This schema does two things: it is the TypeScript type source of truth for the
machine context, and it validates the `xstateSnapshot` when rehydrating from
Postgres — catching snapshot corruption before it causes a silent bad state.

**End state:** a diagram you can walk a colleague through. The XState
implementation in Phase 4 is just translating this diagram into code.

---

## Phase 3 — Single Agent Pass (~2 days)

- Wire Vercel AI SDK + Claude 3.7 Sonnet via Anthropic provider
- Implement **Extractor pass** with `generateText` + `Output.object({ schema: DocumentAnalysisSchema })`
- Implement **Challenger pass** with `generateText` + `Output.object({ schema: GapReportSchema })`
- Tune prompts until output is reliable on the test bundle

**AI SDK v6 note:** `generateObject` is deprecated. Use `generateText` with `Output.object()`:
```ts
import { generateText, Output } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'

const { output } = await generateText({
  model: anthropic('claude-sonnet-4-5'),
  output: Output.object({ schema: DocumentAnalysisSchema }),
  system: systemPrompt,
  messages: [{ role: 'user', content: documentContext }],
})
```
Documents go into `messages` as user content (not the system prompt).
The system prompt describes the task; the documents are the input.

**Zod schemas to define in `src/shared/schemas/agent.ts`:**
```ts
const RequirementSchema = z.object({
  text: z.string(),
  sourceDocument: z.string(),      // required — never optional
  confidence: z.enum(['high', 'medium', 'low']),
})

const DocumentAnalysisSchema = z.object({
  requirements: z.array(RequirementSchema),
  constraints: z.array(RequirementSchema),
  assumptions: z.array(RequirementSchema),
})

const ConflictSchema = z.object({
  description: z.string(),
  documentA: z.string(),           // filename of first source
  documentB: z.string(),           // filename of second source
})

const GapReportSchema = z.object({
  conflicts: z.array(ConflictSchema),
  gaps: z.array(z.object({
    description: z.string(),
    affectedArea: z.string(),
  })),
  ambiguities: z.array(z.object({
    description: z.string(),
    sourceDocument: z.string(),
  })),
})

export type DocumentAnalysis = z.infer<typeof DocumentAnalysisSchema>
export type GapReport = z.infer<typeof GapReportSchema>
```

Run against the test corpus. Verify:
- Zero requirements without `sourceDocument` in Extractor output
- Challenger surfaces the planted contradiction (`documentA` and `documentB` both populated)

**Do not proceed to Phase 4 until the Extractor and Challenger
outputs are trustworthy. Everything downstream depends on them.**

---

## Phase 4 — The Clarifying Loop (~3 days)

- Implement **Question generation pass** with `generateObject` + `ClarifyingQuestionsSchema`
- Wire XState machine: machine suspends on `awaiting_answers` state
- Hono route accepts user answers → fires `USER_ANSWERED` event → machine resumes
- Stop condition guards: `ANSWERS_SUFFICIENT` proceeds to generating,
  `ANSWERS_INSUFFICIENT` loops (capped at 2 rounds by `roundLimitReached` guard)
- Persist questions to `questions` table, answers to `answers` table
- Persist `xstateSnapshot` to `sessions` table on every transition
  (enables server restart recovery)

**Zod schemas to add to `src/shared/schemas/agent.ts`:**
```ts
const ClarifyingQuestionSchema = z.object({
  text: z.string(),
  rationale: z.string(),           // why this question matters
  sourceDocuments: z.array(z.string()), // which docs surface this gap
  priority: z.enum(['high', 'medium', 'low']),
})

const ClarifyingQuestionsSchema = z.object({
  questions: z.array(ClarifyingQuestionSchema).min(3).max(7),
  stopReason: z.enum(['sufficient_gaps', 'round_limit']).optional(),
})

export type ClarifyingQuestions = z.infer<typeof ClarifyingQuestionsSchema>
```

**Zod schema for the answers payload in `src/shared/schemas/api.ts`:**
```ts
const SubmitAnswersSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().uuid(),
    text: z.string().min(1),
  })).min(1),
})
```
Validate `POST /api/sessions/:id/answers` with `@hono/zod-validator` using
`SubmitAnswersSchema` — rejects empty answer submissions before they reach XState.

**This is the core of the project. Expect iteration on the stop
condition logic — it’s the hardest design problem in the codebase.**

---

## Phase 5 — Writer Passes (~2 days)

- Implement **Writer (Brief)** pass: streaming Markdown, stakeholder-readable,
  5 minutes, no jargon, citations back to source documents
- Implement **Writer (PRD)** pass: meta-prompt exercise — written for Claude Code
  or Cursor, not a human. Acceptance criteria, file/module hints, non-goals,
  edge cases, recommended stack. Different structure from a human PRD.
- Stream both outputs via `streamText` → `toDataStreamResponse()`
- Store completed outputs in `outputs` table with `version = 1`
- Wire prompt caching on document context (same context across all passes,
  pay the token cost once)

---

## Phase 6 — Hono API + Streaming (~2 days)

- Wire XState machine to all session routes
- Streaming routes return `toDataStreamResponse()` directly — no custom SSE
- Session rehydration: on request, load `xstateSnapshot` from Postgres, validate
  through `MachineContextSchema`, restore the XState machine
- CORS middleware (`hono/cors`) for SPA origin
- Hono RPC types fully exported — `hc<typeof app>` client ready for consumers

**Zod + `@hono/zod-validator` on every route that accepts a body:**
```ts
// src/shared/schemas/api.ts
const UploadUrlRequestSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive().max(100 * 1024 * 1024), // 100MB hard limit
  documentType: DocumentTypeSchema,
})

const ConfirmUploadSchema = z.object({
  s3Key: z.string().min(1),
})

const SessionIdParamSchema = z.object({
  id: z.string().uuid(),
})

// SubmitAnswersSchema already defined in Phase 4
```
```ts
// src/api/routes/sessions.ts
app.post('/api/sessions/upload-url',
  zValidator('json', UploadUrlRequestSchema),
  async (c) => { ... }
)

app.post('/api/sessions/:id/confirm-upload',
  zValidator('param', SessionIdParamSchema),
  zValidator('json', ConfirmUploadSchema),
  async (c) => { ... }
)

app.post('/api/sessions/:id/answers',
  zValidator('param', SessionIdParamSchema),
  zValidator('json', SubmitAnswersSchema),
  async (c) => { ... }
)
```
Routes without a validated body still validate the `:id` param. A malformed UUID
never reaches the DB or the XState machine.

**End state:** a fully functional HTTP API. CLI and React SPA are
both just clients on top of this.

---

## Phase 7 — CLI (~1 day)

- `clack` prompts for the three-phase wizard:
  - Phase 1: file path input(s) → `POST /api/sessions/upload-url` → upload
    directly to S3 → `POST /api/sessions/:id/confirm-upload` → poll status
  - Phase 2: spinner during analysis → display questions → text prompts for answers
  - Phase 3: spinner → stream output to terminal
- First full end-to-end run of the complete pipeline

**Expect to fix 3–5 things that seemed fine in isolation.
This is the integration test.**

---

## Phase 8 — Langfuse + Evals (~2 days)

- Wire `@langfuse/vercel` — wraps Vercel AI SDK calls with trace/span context
- Note: if using Langfuse Cloud free tier (recommended for dev), just add API keys.
  Self-hosted requires Postgres + ClickHouse + Redis + S3 — defer until needed.
- Build synthetic test corpus:
  - A one-paragraph project description
  - A half-finished PRD draft
  - A fake RFP with constraints buried in it
  - A discovery call transcript with tangents and at least one contradiction
    with the PRD (planted deliberately)
- Run **faithfulness eval**: no hallucinated requirements (LLM-as-judge)
- Run **completeness eval**: nothing important dropped (LLM-as-judge)
- Run **conflict detection eval**: contradiction between transcript and PRD
  is correctly surfaced (deterministic check)
- Verify clarifying loop stop condition fires at the right time

**Zod schema for LLM-as-judge responses in `src/shared/schemas/evals.ts`:**
```ts
const EvalResultSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string(),
  pass: z.boolean(),
  citations: z.array(z.string()).optional(), // which parts of source supported score
})

const FaithfulnessEvalSchema = z.object({
  hallucinatedRequirements: z.array(z.object({
    text: z.string(),
    reason: z.string(),           // why this was deemed hallucinated
  })),
  result: EvalResultSchema,
})

const ConflictDetectionEvalSchema = z.object({
  conflictsSurfaced: z.array(z.string()),   // descriptions of found conflicts
  plantedConflictFound: z.boolean(),        // deterministic check
  result: EvalResultSchema,
})
```
Parse every LLM-as-judge response through these schemas. An unparseable judge
response is a failed eval, not a passing one with a warning.

---

## Phase 9 — React SPA (stretch, after Phase 8)

> Only start this after the backend is solid and evals pass.
> The UI is a presentation layer over something that already works.

- Vite + React setup in `apps/web`
- TanStack Router — three routes: `/`, `/sessions/:id/questions`, `/sessions/:id/output`
- TanStack Query — mutations for upload and answer submission, queries for session status
- assistant-ui + shadcn/ui + Tailwind — Thread/Composer for question loop,
  dual-panel Markdown viewer for outputs
- `hc<typeof app>` Hono RPC client — same endpoints the CLI uses
- Download buttons for Brief and PRD (Markdown files)

---

## Open questions to resolve during build

- Exact token threshold for context vs retrieval mode (tune empirically in Phase 3)
- Whether one clarification round is enough or two are needed (tune in Phase 4)
- Chunking strategy: chunk size, overlap, and minimum chunk size (tune in Phase 1 against retrieval quality)
- Whether `xstateSnapshot` serialisation covers all edge cases or needs custom reducers
- Minimum chunk size threshold — short paragraphs produce low-quality embeddings; merge or discard chunks below a minimum length

---

## Phase 9.5 — Full Effect Rewrite (after Phase 9 SPA, before production)

Complete the Effect migration once the full backend pipeline works end-to-end
and evals pass. Do not start this before Phase 8 gate passes.

### 1. `DatabaseService` — wrap all Drizzle queries

Define a `DatabaseService` as `Context.Service` wrapping all functions from
`src/db/queries.ts`. Each query returns `Effect<T, DbError>` instead of
`Promise<T>`.

```ts
export class DatabaseService extends Context.Service<DatabaseService, {
  createAgentSession(data: InsertAgentSession): Effect.Effect<SelectAgentSession, DbError>
  createDocument(data: InsertDocument): Effect.Effect<SelectDocument, DbError>
  getDocumentById(id: string): Effect.Effect<SelectDocument, DbError | DocumentNotFoundError>
  // ... all other queries
}>()("shipwright/db/DatabaseService") {
  static readonly layer = Layer.effect(DatabaseService, Effect.sync(() => {
    // implement using db from src/db/index.ts
  }))
}
```

Benefits: eliminates all `Effect.tryPromise(...)` wrappers in the pipeline,
enables test layers with mock DB (no real Postgres needed for unit tests).

### 2. `@effect/ai-anthropic` — typed AI layer

Install `@effect/ai-anthropic@4.0.0-beta.78`. Migrate extractor and challenger
from Vercel AI SDK to Effect's provider-agnostic AI layer:

```ts
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"

const AnthropicClientLayer = AnthropicClient.layerConfig({
  apiKey: Config.redacted("ANTHROPIC_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer))
```

- `LanguageModel.generateObject({ schema: EffectSchemas.DocumentAnalysisSchema, ... })`
  replaces `generateText` + `Output.object({ schema: ZodSchema })`
- `AiError` with typed `reason` replaces generic `TextGenerationError`
- `ExecutionPlan` enables provider fallback (Claude → GPT-4o) declaratively
- Effect `Schema.Class` (already in `EffectSchemas` namespace) used throughout

### 3. Parsers + embedder as Effect services

- `parseDocument` → `Effect.fn` returning `Effect<ParseResult, ParseError>`
- `embedChunks` → `Effect.fn` returning `Effect<number[][], EmbedError>`
- Eliminates remaining `Effect.tryPromise` wrappers in `process-uploaded-documents.ts`

### 4. Merge all layers in `runtime.ts`

```ts
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    EffectStorageAdapterService.EffectStorageAdapter.layer,
    DatabaseService.layer,
    AnthropicService.layer,
  ),
  { memoMap: appMemoMap }
)
```

### 5. Delete legacy code

- `S3Storage` class (Promise-based) and `StorageAdapter` interface
- Remaining `Effect.tryPromise` wrappers that wrapped now-Effect functions
- Old Zod schemas in `agent.ts` if fully replaced by `EffectSchemas`

---

## Fine-tuning phase (after Phase 8)

These items were raised in mentor review and deferred deliberately. Revisit
after the core pipeline is working and evals pass.

- **Streaming parse + chunk** — replace buffer-based parsing with stream-based parsing. Pipe the S3 download stream directly into the parser. Reduces memory pressure for large files and concurrent users. Requires verifying `unpdf` and `mammoth` stream support.
- **Persistent processing queue** — `p-queue` (in-process, concurrency: 2) is already in place for V1. Upgrade to `pg-boss` (uses existing Postgres) or `BullMQ` (needs Redis) when job durability across server restarts is needed.
- **`embedMany` batching** — `embedMany` has a request size limit. For documents producing many chunks, implement batching before calling `embedMany`.
- **Document cleanup job** — background job to delete orphaned documents (no linked session), their chunks, and their S3 objects. Prevents storage accumulation from incomplete or abandoned sessions.
- **Chunk metadata enrichment** — DONE in Phase 1. `locationMeta: jsonb` column on `chunks` table typed as `LocationMeta | null`: `{ pageNumber?: number, headingPath?: string, charOffset?: number }`. Chunker returns `{ content: string, locationMeta: LocationMeta }[]`. Parsers emit location hints during parsing.
- **SSE for status updates** — replace `GET /api/sessions/:id` polling with Server-Sent Events via `POST /api/sessions/:id/stream` when building the React SPA.
