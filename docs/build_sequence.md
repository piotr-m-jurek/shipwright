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

- Docker Compose: Postgres + pgvector + garage (S3-compatible local storage)
- Langfuse: use Langfuse Cloud free tier during development; full self-hosted
  stack (Postgres + ClickHouse + Redis + S3) when needed — defer this complexity
- Drizzle schema — all tables including `vector(1536)` column on `chunks`
- Hono skeleton with route stubs + Hono RPC types exported from `src/api/`
- `StorageAdapter` interface defined in `src/storage/` with `garage` implementation
- Environment variable setup (`.env.example` committed, `.env` gitignored)

**End state:** nothing runs, but the project structure, data contract, and
type boundaries are established and won't need to change.

---

## Phase 1 — Document Ingestion (~2 days)

- File upload endpoint on Hono (`POST /api/sessions`, multipart)
- Parsers: `unpdf` (PDF), `mammoth` via `extractRawText()` (DOCX — never use
  `convertToHtml()`, HTML tags pollute embeddings), `fs/promises` (plain text)
- Custom recursive character chunker with overlap
- Metadata tagging per chunk: `sourceDocument`, `documentType`, `chunkIndex`, `sessionId`
- Embed chunks via `OpenAI text-embedding-3-small` through Vercel AI SDK `embed()`
- Store chunks in pgvector via Drizzle `vector()` column
- Store raw files via `StorageAdapter` (garage locally, Supabase Storage in prod)
- Store `tokenCount` on `documents` table (needed for Phase 2 threshold guard)

**End state:** upload a PDF, query semantically related chunks back out.

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
ANSWERS_SUFFICIENT, ANSWERS_INSUFFICIENT, OUTPUT_READY, ERROR
```

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

**End state:** a diagram you can walk a colleague through. The XState
implementation in Phase 4 is just translating this diagram into code.

---

## Phase 3 — Single Agent Pass (~2 days)

- Wire Vercel AI SDK + Claude 3.7 Sonnet via Anthropic provider
- Implement **Extractor pass**: `generateObject` + Zod `DocumentAnalysis` schema
  - Schema requires `sourceDocument` on every requirement (anti-hallucination)
- Run against a real (or synthetic) document bundle
- Verify citation grounding and output quality before proceeding
- Implement **Challenger pass**: `generateObject` + Zod `GapReport` schema
  - Surfaces conflicts, gaps, underspecified requirements
- Tune prompts until output is reliable on the test bundle

**Do not proceed to Phase 4 until the Extractor and Challenger
outputs are trustworthy. Everything downstream depends on them.**

---

## Phase 4 — The Clarifying Loop (~3 days)

- Implement **Question generation pass**: rank gaps by impact, select 3–7
- Wire XState machine: machine suspends on `awaiting_answers` state
- Hono route accepts user answers → fires `USER_ANSWERED` event → machine resumes
- Stop condition guards: `ANSWERS_SUFFICIENT` proceeds to generating,
  `ANSWERS_INSUFFICIENT` loops (capped at 2 rounds by `roundLimitReached` guard)
- Persist questions to `questions` table, answers to `answers` table
- Persist `xstateSnapshot` to `sessions` table on every transition
  (enables server restart recovery)

**This is the core of the project. Expect iteration on the stop
condition logic — it's the hardest design problem in the codebase.**

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
- Session rehydration: on request, load `xstateSnapshot` from Postgres and
  restore the XState machine — no lost state on server restart
- CORS middleware (`hono/cors`) for SPA origin
- Hono RPC types fully exported — `hc<typeof app>` client ready for consumers

**End state:** a fully functional HTTP API. CLI and React SPA are
both just clients on top of this.

---

## Phase 7 — CLI (~1 day)

- `clack` prompts for the three-phase wizard:
  - Phase 1: file path input(s) → `POST /api/sessions`
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
- Chunking strategy: chunk size and overlap (tune in Phase 1 against retrieval quality)
- Whether `xstateSnapshot` serialisation covers all edge cases or needs custom reducers
