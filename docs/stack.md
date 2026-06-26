# Project Description Agent — Stack V1

> **Tag:** V1
> **Project:** Project Description Agent
> **Scope:** TypeScript stack with one clear winner per layer.
> **Architecture:** pnpm workspaces monorepo (Phase 7 deviation from monolith start)

---

## Monorepo Structure

> **Deviation from Phase 0:** The project starts as a monolith (single `package.json`)
> and is restructured into a pnpm workspaces monorepo at Phase 7. This section
> describes the Phase 7+ target layout.

```
apps/
  api/          — Effect HttpApi server, agent pipeline, DB, storage
  web/          — React SPA (Phase 10)
packages/
  shared/       — schemas, domain errors, lib utilities — imported by both apps
```

**Why pnpm workspaces (not Turborepo or Nx):**

pnpm workspace protocol (`workspace:*`) resolves `packages/shared` to the local
version at all times — no accidental npm resolution, no symlink hacks. Turborepo
adds build caching on top; useful if build times become a bottleneck, but not
needed at this scale. Nx is heavier and more opinionated than required.

**Rejected:** Turborepo — adds build caching, not needed at this scale.
Nx — too heavy and opinionated.

**Workspace package names:**

- `@shipwright/api` — `apps/api/package.json`
- `@shipwright/web` — `apps/web/package.json`
- `@shipwright/shared` — `packages/shared/package.json`

**Cross-workspace imports:**

`apps/api` and `apps/web` both declare `"@shipwright/shared": "workspace:*"` as a
dependency. All shared type imports use `@shipwright/shared/schemas`,
`@shipwright/shared/domain`, etc. No direct relative path imports across workspace
boundaries (Rule 14).

**What stays at repo root:**

- `docker-compose.yml`
- `.env` / `.env.example`
- `drizzle.config.ts` (points into `apps/api/src/db/`)
- `pnpm-workspace.yaml`
- Root `package.json` (workspace root only — no source code, no runtime deps)

---

## Layer Map

### 1. 🖥️ UI — Vite + React SPA · TanStack Router · @effect/atom-react · AtomHttpApi · shadcn/ui + Tailwind

**Why:** Clean client/backend separation — frontend is a static SPA, backend is
Effect HttpApi, no server/client component confusion. TanStack Router handles the
three-phase wizard (Upload → Questions → Output) as typed client-side routes.

**Reactive state:** `@effect/atom-react` + `AtomHttpApi` — Effect atoms own all
async server state. `AtomHttpApi.Service` wraps the shared `Api` definition and
exposes typed query atoms and mutation `AtomResultFn`s. React components subscribe
via `useAtomValue`, `useAtom`, and `useAtomSuspense` from `@effect/atom-react`.
TanStack Query is not used — atoms cover caching (`timeToLive`), polling
(`Atom.withRefresh`), stale-while-revalidate (`Atom.swr`), and cache invalidation
(`reactivityKeys`) natively.

**Typed API client:** `AtomHttpApi.Service` built from the shared `Api` definition
in `@shipwright/shared/api`. Both `apps/api` and `apps/web` import the same
`HttpApi` object — request encoding, response decoding, and error types are
guaranteed in sync with zero code generation or build steps. Rule 10 requires all
API calls to go through this client — no raw `fetch()` in the frontend.

**UI components:** shadcn/ui + Tailwind for layout and controls. No assistant-ui —
the question/answer loop is a standard form, not a chat UI. Streaming output
rendered as Markdown in a two-panel viewer.

**Rejected:** TanStack Query — adds a second async state system alongside atoms;
the atom layer covers the same ground natively and keeps the frontend in the same
Effect model as the backend. `openapi-fetch` + `openapi-typescript` — code
generation step that becomes unnecessary when both sides share the `Api` definition
directly. Next.js App Router — SSR complexity not needed for this SPA.
Mastra client SDK — trades control for convenience.

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

### 3. 🤖 Agent / Orchestration — `@effect/ai` + XState

**Why:** `@effect/ai` (`effect/unstable/ai`) provides provider-agnostic LLM primitives:
`LanguageModel.generateObject`, `LanguageModel.streamText`, `EmbeddingModel.embedMany`.
Provider clients (`AnthropicClient` via `@effect/ai-anthropic`, `OpenAiClient` via
`@effect/ai-openai`) are registered once as layers in `src/agent/providers.ts` and
injected via `Layer.provide` at the call site — every agent pass is completely
provider-agnostic. XState owns the execution flow.

**`@effect/ai` is the only LLM interface — no Vercel AI SDK, no direct `@anthropic-ai/sdk`.**
Provider registration happens once in `providers.ts`. Swapping Claude for GPT-4o or
Gemini is a layer swap in `providers.ts`, not a refactor across agent passes. This is
strictly better provider isolation than the previous Vercel AI SDK approach — call
sites are decoupled from the provider at the type level via the `LanguageModel` service.

**Design intent — DIY Mastra:**
The goal is to build what Mastra gives you out of the box, but manually:

- `@effect/ai` `LanguageModel` → provider-agnostic LLM calls
- XState machines → workflow orchestration and agent loop control
- XState actors → each async LLM pass invoked from the machine
- XState context → state flowing through the pipeline (docs, questions, answers)
- XState guards → stop conditions for the clarifying loop
- Postgres + Drizzle + `DatabaseService` → memory and conversation history
- pgvector + Drizzle → retrieval when context exceeds the window
- Langfuse → observability

**Effect integration:** XState actors bridge into the Effect runtime via
`Effect.runForkWith(services)(effect)` — the full service context (DB, storage,
config) is available inside every actor without thread-local state or globals.
Effect owns typed errors, dependency injection, and structured concurrency.

**RAG additions (Phase 11):**

- **Retrieval mode** — when `tokensBelowThreshold` guard fires `false`, the pipeline
  switches from stuffing all summaries into context to querying pgvector for the
  top-k most relevant summaries by cosine similarity.
- **`query_chunks` tool** — available to all agent passes (Challenger, Question
  Generator, all Writers). Lets the model issue targeted pgvector queries when it
  needs more detail. Primary use case: Revision Writer. Optional — the model decides
  when to call it.

**Rejected:** LangChain.js — leaky abstractions. Mastra — pre-assembles exactly what
we want to learn to assemble. Vercel AI SDK — replaced by `@effect/ai` for full
Effect consistency; no mixed dependency model.

---

### 4. 🧠 LLM / Prompt — Claude · Effect Schema · Prompt Caching

**Why:** Claude is the primary model — best-in-class instruction following, structured
output reliability, and faithfulness to source material (critical: hallucinated
requirements are the worst failure mode). 200k context handles most realistic input
bundles. Accessed exclusively via `@effect/ai-anthropic` through the `LanguageModel`
abstraction.

**Gemini 2.5 Pro as explicit overflow fallback:** when a single document exceeds what
fits in 200k alongside system prompt and output buffer, Gemini's 1M window handles it
without chunking. Provider switch is a layer swap in `providers.ts` — one change, no
call-site refactor.

**Each pass has a purpose-built system prompt:**

- Summarizer (map) — summarise a batch of chunks from one document into an intermediate summary
- Summarizer (reduce) — combine intermediate summaries into a single per-document summary; cite every claim to its source
- Challenger — compare per-document summaries; find gaps, contradictions, underspecified requirements; structured gap report
- Question generator — rank gaps by impact, select 3–7, write answerable questions
- Writer (Brief) — stakeholder-readable, five minutes, no jargon; cites sourceDocument fields from summaries
- Writer (PRD) — written for a coding agent, not a human; acceptance criteria,
  file/module hints, non-goals, edge cases, stack hints. Meta-prompting exercise.
- Revision Writer — receives existing outputs + free-form feedback + summaries; regenerates both outputs

**Effect Schema as anti-hallucination layer:** `LanguageModel.generateObject` +
`Schema.Struct` on the analysis and question-generation passes. Schemas require
`sourceDocument` fields on every requirement — uncited claims are structurally
impossible, not just instructed against. Schema decode failures are typed errors,
not runtime crashes.

**Prompt caching:** document context is identical across Challenger and Writer passes.
Claude's prompt caching pays the token cost once. Configured via `@effect/ai-anthropic`
provider options.

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

### 7. 🗄️ Database — PostgreSQL + Drizzle ORM + `@effect/sql-pg` + `DatabaseService`

**Why:** PostgreSQL hosts both relational data and pgvector embeddings — one service,
one migration pipeline, one connection string. Drizzle ORM is TypeScript-first:
schema defined in TypeScript, `vector()` column type maps directly to pgvector,
no code generation step, no separate schema file.

**Effect-native DB layer (complete):** `@effect/sql-pg` + `drizzle-orm/effect-postgres`
replace `postgres.js`. The `DB` service (`src/db/index.ts`) exposes a Drizzle instance
whose query methods return `Effect` directly — no `Effect.tryPromise` wrappers anywhere.
All 20+ query functions live in `DatabaseService` (`src/db/queries.ts`) as a
`Context.Service` — each method returns `Effect<T, EffectDrizzleQueryError>`. Zero
Promise bridges in the DB layer.

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

### 10. 📬 Queue — QueuePort (hexagonal) · InMemoryQueueLive · pg-boss (production)

**Why:** Every HTTP handler that returns `202 Accepted` triggers async work. That
work must be observable, retryable, and swappable without touching call sites.
A `QueuePort` Effect `Context.Service` gives a single enqueue/subscribe interface;
the implementation is swapped from in-memory to durable without changing any
handler or agent code. Rule 16 enforces this: no handler may fork work directly.

**Port definition** (`apps/api/src/queue/index.ts`):

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

**Job types** (defined in `packages/shared/src/schemas/queue.ts`):

| Job | Trigger | Completion event |
|---|---|---|
| `DocumentProcessingJob` | `POST /api/sessions/:id/confirm-upload` | `PROCESSING_DONE` |
| `SummarizationJob` | after `PROCESSING_DONE` or `UPLOAD_COMPLETE` | `SUMMARIZATION_DONE` |
| `AnalysisJob` | `POST /api/sessions/:id/confirm` (user confirm) | `ANALYSIS_DONE` |
| `GenerationJob` | `ANSWERS_SUFFICIENT` or `roundLimitReached` | `OUTPUT_READY` |
| `RevisionJob` | `POST /api/sessions/:id/revise` | `OUTPUT_READY` |

Each job carries `{ type, sessionId, ...payload }`. Job handler fires
`sendMachineEvent(sessionId, completionEvent)` on success. XState remains
the single source of truth for session state.

**`InMemoryQueueLive`** — wraps the existing `p-queue` singleton. Concurrency
configurable per job type. Not durable: jobs lost on server restart. Acceptable
for V1 — XState snapshot rehydration can re-trigger any stuck session on restart.

**Production upgrade:** `pg-boss` — Postgres-backed job queue using the existing
DB connection. At-least-once delivery, retry with backoff, dead-letter queue.
No new infrastructure — same port, different `Layer`. Deferred to fine-tuning phase.

**Rejected:** bare `p-queue` singleton without a port — not swappable, not testable,
violates Rule 16. BullMQ directly — requires Redis before pg-boss (Postgres) is
exhausted. RabbitMQ/SQS — external service dependency not justified at this scale.

---

### 11. 🔐 Auth — Better Auth + drizzleAdapter (Phase 12)

**Prerequisite:** `better-auth/better-auth#9489` (Drizzle Relations v2 support)
merged into better-auth's `next` branch. A preview build is available at
`pkg.pr.new/better-auth@9489` and `pkg.pr.new/@better-auth/drizzle-adapter@9489`
but is not used until the PR merges — it changes as the PR is revised.

**What it adds:**

- `users` table (Better Auth managed)
- `sessions` table (Better Auth managed — separate from `agent_sessions`)
- `agent_sessions.userId` FK — every agent session belongs to a user
- OAuth providers: GitHub + Google
- Auth routes: `auth.handler` mounted at `/api/auth/*` as a fetch passthrough
  in `HttpRouter` — no adapter needed, `(Request) => Promise<Response>` drops in
- `CurrentUser` `Context.Tag` + `HttpApiMiddleware` — typed user injected into
  every protected handler context; a handler that touches user data won't compile
  without the middleware present

**Row-level security (application-level):** every `DatabaseService` query method
that touches `agent_sessions`, `documents`, `chunks`, or `outputs` must filter
by `userId`. Pattern: `WHERE user_id = currentUser.id` on every query.
Postgres RLS policies deferred — application-level enforcement is sufficient for V1.

**`HttpApiMiddleware` pattern:**

```ts
class CurrentUser extends Context.Tag("shipwright/CurrentUser")<
  CurrentUser,
  { id: string; email: string }
>() {}

const AuthMiddleware = HttpApiMiddleware.make(CurrentUser, {
  // extract session from cookie, validate via Better Auth, yield CurrentUser
})

// Protected group — won't compile without CurrentUser in scope
class SessionsApiGroup extends HttpApiGroup.make("sessions")
  .middleware(AuthMiddleware)
  .add(...)
{}
```

**Why Better Auth over alternatives:**

| | Better Auth | Auth.js | Lucia |
|---|---|---|---|
| Drizzle adapter | yes (PR #9489) | no | manual |
| TypeScript-first | yes | partial | yes |
| Session management | built in | built in | manual |
| Relations v2 compatible | yes (PR #9489) | n/a | n/a |
| Maintenance | active | active | archived |

Lucia is archived. Auth.js has no Drizzle v1 adapter. Better Auth with
`@better-auth/drizzle-adapter` is the only option that shares the existing
Drizzle v1 schema without a second ORM or connection pool.

---

### 12. 🚀 Deployment

See `docs/deployment.md` for the full plan.

**Short version:** single Docker image (multi-stage build), Effect server serves
API + static SPA, `drizzle-kit migrate` as pre-deploy step, secrets via env vars,
GitHub Actions CI/CD. Platform (Fly.io / AWS ECS / Railway / Render) decided when
traffic requirements are known.

---

## Final Stack Summary

| Layer                 | Winner                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Repo structure        | pnpm workspaces · apps/api · apps/web · packages/shared                                                  |
| UI                    | Vite + React · TanStack Router · @effect/atom-react · AtomHttpApi · shadcn/ui + Tailwind                 |
| API client (frontend) | AtomHttpApi.Service + HttpApiClient (from shared Api definition in @shipwright/shared/api)                |
| API                   | Effect HttpApi (`effect/unstable/httpapi`) · NodeRuntime                                                 |
| Agent / Orchestration | `@effect/ai` (`LanguageModel`, `EmbeddingModel`) + XState + Effect                                      |
| RAG                   | pgvector retrieval mode + `query_chunks` `@effect/ai` tool (Phase 11)                                    |
| LLM / Prompt          | Claude 3.7 Sonnet · Zod · Prompt Caching                                                                 |
| Document Processing   | unpdf + mammoth (extractRawText) + Node.js fs                                                            |
| Vector DB / Retrieval | pgvector (Postgres) + OpenAI text-embedding-3-small                                                      |
| Database              | PostgreSQL + Drizzle ORM + `@effect/sql-pg` + `DatabaseService` (Effect-native, complete)                |
| File Storage          | StorageAdapter (Effect Context.Service) · @aws-sdk/client-s3 · rustfs → Supabase Storage                |
| Queue                 | QueuePort (Effect Context.Service) · InMemoryQueueLive (p-queue) → pg-boss (production)                 |
| Auth                  | Better Auth + @better-auth/drizzle-adapter · CurrentUser HttpApiMiddleware (Phase 12)                    |
| Observability / Evals | Langfuse (full stack: Postgres + ClickHouse + Redis + S3)                                                |
| Deployment            | Docker (multi-stage) · GitHub Actions · Terraform (platform TBD) — see docs/deployment.md               |

---

## Open questions for V2

- Does the multi-agent stretch goal warrant adopting LangGraph.js from the start,
  or is `@effect/ai` sufficient for V1?
- pgvector is now the vector store — does the Drizzle schema need a dedicated
  chunks table or can embeddings live alongside the documents table?
- Langfuse Cloud vs self-hosted during active development — which is less friction?
