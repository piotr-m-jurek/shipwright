# Project Description Agent — Stack V1

> **Tag:** V1
> **Project:** Project Description Agent
> **Scope:** TypeScript stack with one clear winner per layer.

---

## Layer Map

### 1. 🖥️ UI — Vite + React SPA · TanStack Router · TanStack Query · assistant-ui · shadcn/ui + Tailwind · Vercel AI SDK UI

**Why:** Clean client/backend separation — frontend is a static SPA, backend is Hono,
no server/client component confusion. TanStack Router handles the three-phase wizard
(Upload → Questions → Output) as typed client-side routes. TanStack Query owns all
async state: mutations for file upload and answer submission, queries for session
status. assistant-ui provides Thread/Composer/Message components built directly on
shadcn/ui primitives. Vercel AI SDK UI (`useChat` from `@ai-sdk/react`) handles
streaming consumption, connecting assistant-ui's `AssistantChatTransport` to Hono's
streaming endpoints.

**Control rationale:** Raw Anthropic SDK + Vercel AI SDK on the backend (not Mastra)
gives full visibility into every LLM call. Mastra would abstract too much of the
backend learning surface for an upskilling project.

**Rejected:** Next.js App Router — SSR/client boundary adds complexity for a tool
focused on agent logic. Mastra client SDK — trades control for convenience.
CopilotKit — too opinionated, heavier than needed.

---

### 2. 🔌 API — Effect HttpApi (`effect/unstable/httpapi`)

**Why:** The codebase is Effect-first throughout. Effect's `HttpApiBuilder` provides
typed endpoint definitions, automatic OpenAPI/Scalar documentation generation, and
integrates directly with the Effect runtime — no bridge layer needed between the HTTP
server and the rest of the Effect pipeline. Route handlers are plain Effect generators;
the `Layer` system wires dependencies. This is a deliberate deviation from the original
Hono plan, made after the storage and agent layers were already Effect services.

**Deviation from original plan:** The original design specified Hono + Hono RPC. The
switch to Effect HttpApi was made because the entire backend is Effect — using Hono
would require a bridge between Effect services and Promise-based Hono handlers. Effect
HttpApi eliminates that boundary entirely. The frontend type safety story changes: instead
of `hc<typeof app>`, the OpenAPI schema is used to generate a typed client.

**Route map:**

- `POST /api/sessions/upload-url` — generate presigned S3 PUT URL, create session record
- `POST /api/sessions/:id/confirm-upload` — verify upload via HeadObject, start processing async
- `GET  /api/sessions/:id` — get session status + questions
- `POST /api/sessions/:id/stream` — trigger analysis, stream progress + questions
- `POST /api/sessions/:id/answers` — submit clarifying answers
- `GET  /api/sessions/:id/output` — stream the two output documents
- `GET  /api/sessions/:id/output/:type/download-url` — presigned S3 GET URL for final output
- `POST /api/sessions/:id/revise` — submit free-form revision feedback, trigger re-generation

**Server structure:** `src/server/server.ts` — `HttpApiGroup` defines endpoint schemas,
`HttpApiBuilder.group` implements handlers, `NodeRuntime.runMain` launches the server.
`StorageAdapter.layer` and future `DatabaseService.layer` are provided via `Layer.provide`.

**Rejected:** Hono + Hono RPC — requires Promise bridge to Effect services, loses
type-level integration with the Effect runtime. NestJS — too heavy. Plain REST — no
type safety.

---

### 3. 🤖 Agent / Orchestration — Vercel AI SDK Core + XState

**Why:** Vercel AI SDK Core provides the LLM primitives (`streamText`, `generateObject`,
`tool`). XState owns the execution flow — states, transitions, guards, parallel actors,
and the suspend/resume pattern needed for the HITL clarifying loop. Together they
assemble a Mastra-equivalent orchestration layer from first principles, without the
framework abstraction hiding what's actually happening.

**Vercel AI SDK is the only LLM interface — no direct Anthropic SDK calls.**
The Anthropic SDK is installed as a provider and registered once:
`import { anthropic } from '@ai-sdk/anthropic'`. Every LLM call in the codebase
goes through `generateObject()` or `streamText()`. Nothing calls
`anthropic.messages.create()` directly. This keeps provider flexibility intact —
swapping to GPT-4o or Gemini is one line, not a refactor.

**Design intent — DIY Mastra:**
The goal is to build what Mastra gives you out of the box, but manually:

- Vercel AI SDK `tool()` → tool definition and routing
- XState machines → workflow orchestration and agent loop control
- XState actors → each async LLM pass as an invoked actor
- XState context → state flowing through the pipeline (docs, questions, answers)
- XState guards → stop conditions for the clarifying loop
- Postgres + Drizzle → memory and conversation history
- pgvector + Drizzle → retrieval when context exceeds the window
- Langfuse → observability
  This is the full Mastra bill of materials, assembled by hand.

**Effect-TS integration:** Effect wraps all side-effecting work inside XState actors
via `Effect.runPromise`. The full backend is Effect — storage, DB, LLM calls, parsing,
chunking, summarization. XState owns state transitions and the HITL suspend/resume
pattern. Effect owns typed errors, dependency injection, and structured concurrency
within each actor. This is the chosen architecture, not a stretch goal.

**Rejected:** LangChain.js — leaky abstractions. Mastra — pre-assembles exactly what
we want to learn to assemble. Raw loop control without XState — works for V1 single
agent but becomes unmanageable as the graph grows.

---

### 4. 🧠 LLM / Prompt — Claude 3.7 Sonnet · Zod · Prompt Caching

**Why:** Claude 3.7 Sonnet is the primary model — best-in-class instruction following,
structured output reliability, and faithfulness to source material (critical: hallucinated
requirements are the worst failure mode). 200k context handles most realistic input
bundles. Accessed exclusively via the Anthropic provider in Vercel AI SDK.

**Gemini 2.5 Pro as explicit overflow fallback:** when a single document exceeds what
fits in 200k alongside system prompt and output buffer, Gemini's 1M window handles it
without chunking. Provider switch is wired via Vercel AI SDK from day one — one line
change.

**Each pass has a purpose-built system prompt:**

- Summarizer (map) — summarise a batch of chunks from one document into an intermediate summary
- Summarizer (reduce) — combine intermediate summaries into a single per-document summary; cite every claim to its source
- Challenger — compare per-document summaries; find gaps, contradictions, underspecified requirements; structured gap report
- Question generator — rank gaps by impact, select 3–7, write answerable questions
- Writer (Brief) — stakeholder-readable, five minutes, no jargon; cites sourceDocument fields from summaries
- Writer (PRD) — written for a coding agent, not a human; acceptance criteria,
  file/module hints, non-goals, edge cases, stack hints. Meta-prompting exercise.
- Revision Writer — receives existing outputs + free-form feedback + summaries; regenerates both outputs

**Zod schemas as anti-hallucination layer:** `generateObject` + Zod on the analysis
and question-generation passes. Schemas require `sourceDocument` fields on every
requirement — uncited claims are structurally impossible, not just instructed against.

**Prompt caching:** document context is identical across Extractor, Challenger, and
Writer passes. Claude's prompt caching pays the token cost once. Wired from day one —
few lines of Anthropic provider config.

**Instructor-js:** deferred. Vercel AI SDK `generateObject` + Zod covers structured
output for V1. Instructor-js (automatic retry on schema validation failure) added only
if reliability becomes a measured problem in testing.

**Rejected:** GPT-4o as primary — weaker on long-context faithfulness. Gemini as
primary — strong context window but weaker instruction following for this task shape.

---

### 5. 📄 Document Processing — unpdf + mammoth + Node.js fs

**Why:** Three small, purpose-built libraries over one large framework. Each does
exactly one thing well. Fits the control priority — explicit, easy to debug, minimal
surface area.

- `unpdf` — PDF text extraction designed for Node/edge environments; avoids the
  native dependency and canvas issues `pdfjs-dist` has when bundled in Docker on Linux
- `mammoth` — DOCX → plain text via `extractRawText()`. **Important:** do not use
  mammoth's HTML output for chunking or embedding. HTML tags (`<p>`, `<strong>`,
  `<ul>`) are semantically meaningless tokens that add noise to embedding vectors
  and hurt retrieval quality. Always call `extractRawText()`, not `convertToHtml()`.
- Node.js `fs/promises` — plain text and Markdown, zero dependency

**Committed formats:** PDF, DOCX, plain text/Markdown. Everything else deferred.

**Chunking:** custom recursive character splitter with overlap (~30 lines of
TypeScript). No dependency needed. Semantic chunking (split at meaning boundaries)
is a quality upgrade for a later iteration.

**Metadata tagging:** every chunk carries `sourceDocument`, `documentType`
(transcript | prd_draft | rfp | notes), `chunkIndex`, and `sessionId`. This is what
lets the Challenger attribute conflicts to specific files rather than just flagging
that a conflict exists. Metadata schema flows directly into pgvector SQL WHERE filters.

**Rejected:** `pdfjs-dist` — native dependency issues in Docker on Linux with Node;
use `unpdf` instead. LlamaIndex.TS — large dependency, brings query engines and
retrieval pipelines we're building ourselves. Unstructured API — external HTTP
dependency and cost. markitdown — subprocess call.

---

### 6. 🔍 Vector DB / Retrieval — pgvector + OpenAI text-embedding-3-small

**Why:** pgvector collapses the vector store and relational DB into one service —
one Docker container, one connection string, one migration system, one backup.
At the scale of this project (a few hundred chunks per session at most), Qdrant's
indexing optimisations are irrelevant. Exact KNN over a few hundred vectors is fast
enough in Postgres.

Metadata filtering is plain SQL `WHERE` clauses — `document_type`, `session_id`,
`source_document` — fully typed through Drizzle, no separate query language to learn.
Vector inserts and session metadata inserts share the same transaction.

Drizzle has native pgvector support via the `vector()` column type and cosine
similarity operators. The chunks table lives alongside the sessions and messages
tables — one schema, one ORM, consistent ergonomics throughout.

**Chunks are always the read path for analysis passes.** Raw document text is never
passed directly into an Extractor or Challenger LLM call. The summarization pass
(Phase 3) reads chunks from pgvector, runs a map-reduce summarization per document,
and stores a compact per-document summary in the DB. All downstream passes
(Challenger, Question Generator, Writer) consume summaries, not raw text.

**Retrieval as fallback only:** for very large bundles where the combined size of all
per-document summaries exceeds the context window, the XState `tokensBelowThreshold`
guard switches to retrieval mode — retrieving summaries by priority rather than
stuffing all of them. This decision is visible in the state machine, not buried in a
utility function. The threshold is evaluated against summary token counts, not raw
document token counts.

**Embedding model:** OpenAI `text-embedding-3-small` via Vercel AI SDK `embed()`.
Good cost/performance ratio. Local models (`@xenova/transformers`) deferred — adds
latency and setup complexity not worth it for V1.

**Summarization strategy — decision deferred, three options kept open:**

The `src/agent/summarizer.ts` interface is written so the strategy is swappable.
No final choice made — implement and benchmark against the test corpus.

| Strategy               | How it works                                                                           | Trade-off                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Map-reduce**         | Batch N chunks → parallel intermediate summaries → single reduce call                  | Simple, parallelisable. Can lose coherence at batch boundaries.                        |
| **Hierarchical**       | Summarise pairs of chunks recursively until one summary remains                        | Better cross-boundary coherence. Moderate added complexity.                            |
| **Agentic with tools** | Model issues `query_chunks(query)` calls to pgvector, builds understanding iteratively | Most flexible for sparse key information. Hardest to bound — model decides call count. |

Note: with Gemini 2.5 Pro (1M context) already in the stack as overflow fallback,
very large single documents can bypass summarization entirely by routing there.
Summarization strategy applies to the typical document size where chunking is needed.

**Rejected:** Qdrant — right for large-scale production RAG, wrong for this project's
scale; adds an unnecessary second service. Pinecone — vendor lock-in. Chroma —
weaker production story.

---

### 7. 🗄️ Database — PostgreSQL + Drizzle ORM + postgres.js + Effect DatabaseService

**Why:** PostgreSQL hosts both relational data and pgvector embeddings — one service,
one migration pipeline, one connection string. Drizzle ORM is TypeScript-first:
schema defined in TypeScript, `vector()` column type maps directly to pgvector,
no code generation step, no separate schema file. `postgres.js` as the driver —
faster than `pg`, TypeScript-native, clean API.

**Effect DB layer migration (in progress):** All Drizzle query functions in
`src/db/queries.ts` will be wrapped in a `DatabaseService` Effect `Context.Service`.
Each query returns `Effect<T, DbError>` instead of `Promise<T>`. This eliminates
`Effect.tryPromise` wrappers at every call site, enables test layers with mock DB,
and keeps the full backend in one consistent Effect pipeline. Migration happens
incrementally alongside the phase build — raw promise queries in `queries.ts` are
replaced with Effect service methods as each phase is built.

**Schema tables:**

- `agent_sessions` — id, status, inputMode (context | retrieval), xstateSnapshot, createdAt
- `documents` — id, sessionId, filename, documentType, storagePath, rawText, tokenCount, mimeType, sizeBytes
- `chunks` — id, documentId, sessionId, content, chunkIndex, embedding vector(1536), documentType, charOffset, pageNumber, headingPath
- `document_summaries` — id, documentId, sessionId, sourceDocument, version, summaryType (map_intermediate | final), batchIndex, content (prose), tokenCount, createdAt
- `summary_items` — id, summaryId → document_summaries.id, itemType (requirement | constraint | assumption), text, sourceDocument, confidence (high | medium | low), orderIndex
- `messages` — id, sessionId, role, content, agentPass, createdAt
- `questions` — id, sessionId, text, rationale, sourceDocuments, orderIndex
- `answers` — id, questionId, sessionId, text, round
- `outputs` — id, sessionId, type (project_brief | implementation_prd), content, version, createdAt

**XState ↔ Postgres:** session `status` mirrors the XState machine state. XState
`Snapshot` serialised to `xstateSnapshot` — on server restart, sessions rehydrate
directly back into running machines. No lost state, no event replay needed.

**Key design decisions:**

- `tokenCount` on documents is the data point the XState machine reads to decide
  context vs retrieval mode — explicit, not buried in a utility function
- `agentPass` on messages lets you reconstruct what each agent pass saw
- `version` on outputs is the versioning stretch goal's foundation — costs nothing
  to add now
- `documentType` denormalised onto chunks for pgvector filter query performance

**Migrations:** `drizzle-kit push` during active development, `drizzle-kit migrate`
for production. Docker Compose with a single Postgres container for local dev.

**Rejected:** Prisma — separate schema file, code generation step, heavier runtime.
SQLite/Turso — no pgvector support. MongoDB — mismatch for relational
session/output history.

---

### 8. 🗃️ File Storage — StorageAdapter interface · @aws-sdk/client-s3 · rustfs (local) → Supabase Storage (prod)

**Why:** File storage is a swappable component — wrap it behind a `StorageAdapter`
interface (`upload()`, `download()`, `delete()`) so implementations can be swapped
without touching call sites. This applies to other independent components too
(email, notifications, etc.) — adapter pattern keeps the core logic clean.

**S3-compatible API as the abstraction:** Supabase Storage is S3 under the hood.
`@aws-sdk/client-s3` works against Supabase Storage, AWS S3, and any S3-compatible
local server with the same client code — no switching cost between environments.

**Local dev:** `rustfs` as the S3-compatible local server.
Both are lightweight, Docker-friendly, and actively maintained. MinIO is explicitly
outdated — avoid it.

**Production:** Supabase Storage — S3-compatible, integrates with the existing
Postgres layer, TypeScript SDK, no new infrastructure vendor.

**Rejected:** Vercel Blob — vendor lock-in. MinIO — outdated, superseded by rustfs
and rustfs. AWS S3 directly in prod without the adapter — locks call sites to one
provider.

---

### 9. 📊 Observability / Evals — Langfuse

**Why:** Explicitly called out in the project document (M6). Open-source, Apache 2.0.
Framework-agnostic: `@langfuse/vercel` wraps Vercel AI SDK calls with zero friction.
Built-in LLM-as-judge scorers (faithfulness, completeness, hallucination) map directly
to the eval suite the project doc describes.

**Self-hosted infra — be realistic about the cost:**
Langfuse self-hosted is not a single container. It requires:

- **Postgres** — transactional data (can share the existing project Postgres)
- **ClickHouse** — columnar OLAP database for traces, observations, and scores.
  Required for metrics dashboards and analytical queries. Without it, you lose the
  ability to build aggregate metrics across runs — which is most of the eval value.
- **Redis / Valkey** — queue and cache
- **S3 / Blob Store** — stores raw events, multimodal inputs, large exports

**Postgres-only mode exists** but strips out metrics and analytics. Acceptable for
early tracing, not for the eval suite the project needs.

**Practical approach:** run the full Langfuse Docker Compose stack locally. It's
heavy but self-contained. Alternatively, use Langfuse Cloud (managed) during
development and self-host only when needed — they offer a free cloud tier.

**LangSmith** was the main alternative. Its trace inspection UI is genuinely better.
But: hosted-only (data leaves your machine), LangChain-centric, paid wall earlier.

**Rejected:** LangSmith — hosted-only, LangChain-centric, paid earlier.
Braintrust — smaller community. Helicone — proxy-based, weak eval story.

---

## Final Stack Summary

| Layer                 | Winner                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------- |
| UI                    | Vite + React · TanStack Router · TanStack Query · assistant-ui · shadcn/ui · Vercel AI SDK UI |
| API                   | Effect HttpApi (`effect/unstable/httpapi`) · NodeRuntime                                      |
| Agent / Orchestration | Vercel AI SDK Core + XState + Effect (typed errors, DI, concurrency)                         |
| LLM / Prompt          | Claude 3.7 Sonnet · Zod · Prompt Caching                                                      |
| Document Processing   | unpdf + mammoth (extractRawText) + Node.js fs                                                 |
| Vector DB / Retrieval | pgvector (Postgres) + OpenAI text-embedding-3-small                                           |
| Database              | PostgreSQL + Drizzle ORM + postgres.js + Effect DatabaseService (in progress)                 |
| File Storage          | StorageAdapter (Effect Context.Service) · @aws-sdk/client-s3 · rustfs → Supabase Storage     |
| Observability / Evals | Langfuse (full stack: Postgres + ClickHouse + Redis + S3)                                     |

---

## Open questions for V2

- Does the multi-agent stretch goal warrant adopting LangGraph.js from the start,
  or is Vercel AI SDK Core sufficient for V1?
- pgvector is now the vector store — does the Drizzle schema need a dedicated
  chunks table or can embeddings live alongside the documents table?
- Langfuse Cloud vs self-hosted during active development — which is less friction?
