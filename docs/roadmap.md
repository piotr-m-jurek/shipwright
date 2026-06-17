# Shipwright — Roadmap Beyond V1

> **Read this when:** V1 is shipped, evals pass, Phase 8 gate is closed.
> **Purpose:** Where this project can go next, framed around what you'll learn,
> not just what you'll build. Each section names the concept, what V1 already
> teaches you about it, and what the upgrade unlocks.

---

## What V1 gives you

By the end of Phase 8 you have:

- A fully working agent pipeline (ingest → summarise → challenge → ask → write)
- XState managing a non-trivial HITL workflow with suspend/resume and server-restart recovery
- Effect-TS as a typed runtime for errors, DI, and concurrency across the whole backend
- RAG fundamentals: chunking, embedding, pgvector retrieval, metadata filtering
- LLM structured output with schema-enforced anti-hallucination
- Streaming prose output with prompt caching
- Langfuse traces across every agent pass
- A working eval suite with faithfulness, completeness, and conflict-detection scores

That is the foundation. Everything below builds on it — none of it requires starting over.

---

## V2 — Multi-Agent Split

**The stretch goal from `project_description.md`.**

Split the single pipeline into three agents with explicit interfaces between them:

| Agent | Responsibility | Input | Output |
|---|---|---|---|
| Extractor | Per-document summarisation (map-reduce) | chunks from DB | `DocumentSummary[]` |
| Challenger | Cross-document conflict + gap analysis | `DocumentSummary[]` | `GapReport` |
| Writer | Output generation | `GapReport` + answers + summaries | Brief + PRD |

**What this teaches:**

- **Agent-to-agent contracts** — typed interfaces between agents prevent one agent's hallucination
  from silently propagating to the next. You'll feel immediately why this matters.
- **Parallel agent execution** — Extractor runs once per document; all documents can be
  summarised in parallel. XState parallel states model this naturally.
- **XState parallel states** — the current machine is sequential. V2 adds a parallel
  `processing` region where each document is summarised concurrently. This is the hardest
  XState concept; V1 doesn't teach it.
- **Error isolation** — if one document's summariser fails, the session should not fail entirely.
  Per-actor error handling with partial results is a new design problem.

**Stack changes:** None required. This is a refactor of `src/agent/`, not a new infrastructure layer.

---

## V2 — Direct Coding Agent Handoff

**The other stretch goal from `project_description.md`.**

Wire the Implementation PRD directly into a Claude Code or Cursor session. The user
sees the PRD and can launch it with one click.

**What this teaches:**

- **MCP servers** — a custom MCP server can expose the session's outputs as resources
  that a coding agent can read. Writing an MCP server means learning the MCP protocol,
  resource definitions, and tool definitions from scratch.
- **Tool use in reverse** — you've been calling tools from your agent. An MCP server
  means *you* are the tool server, and a coding agent is your client. The mental model
  inverts.
- **Prompt design for coding agents** — the Implementation PRD is already structured for
  this. Connecting it to a real agent run lets you measure whether the PRD's structure
  actually improves the agent's output. This is the meta-prompting payoff.

**Stack changes:** New `src/mcp/` folder. MCP SDK (`@modelcontextprotocol/sdk`). The rest
of the stack is untouched.

---

## V3 — Authentication + Multi-Tenancy

**The deliberately deferred item from Phase 1.**

Add user accounts so multiple people can use the app without seeing each other's sessions.

**What this teaches:**

- **Authentication fundamentals** — Better Auth handles OAuth (GitHub, Google) and
  session management. But you'll need to understand what a session token is, how it's
  validated on each request, and why HTTP-only cookies are the right storage mechanism.
- **Row-level security** — every DB query must filter by `userId`. Two patterns:
  application-level (`WHERE user_id = currentUser.id` on every query) vs Postgres
  row-level security policies. You'll implement the first and understand why the second
  exists.
- **Auth middleware in Effect HttpApi** — `HttpApiMiddleware` injects a typed `CurrentUser`
  into handler context. A handler that touches user data won't compile without the
  middleware present. This is how typed DI prevents auth bugs at compile time.
- **Drizzle v1 stable** — this was blocked on drizzle-orm v1 beta stability. By V3 it
  should be stable; the migration is documented in `progress.md`.

**Stack changes:** Better Auth + `drizzleAdapter`. Auth routes mounted at `/api/auth/*`.
Schema gets a `users` table. Every `agent_sessions` row gets a `user_id` FK.

---

## V3 — Output Versioning + Diff

**The versioning stretch goal from `project_description.md`.**

Re-run the pipeline with new documents added to an existing session. Show what changed
between the old and new Brief/PRD.

**What this teaches:**

- **Semantic diffing** — character diffs (`diff` library) work for text but produce noise
  on reformatted outputs. Section-level diffing (split by heading, compare per-section)
  is more useful. Both approaches have trade-offs to reason about.
- **Immutable version history** — the `outputs` table already has a `version` column.
  V3 means the UI must show all versions, not just the latest. Querying by `version DESC`
  is already in the schema; the challenge is the presentation and the diff computation.
- **Re-summarisation without re-ingestion** — adding a new document to an existing session
  means: ingest the new doc, run map-reduce on it, re-run the Challenger with the new
  summary included, run the clarifying loop again (or skip if no new gaps), re-generate.
  This is a partial pipeline re-run, not a full restart. XState's `revising` state was
  designed for exactly this.

**Stack changes:** New DB queries for version history. New XState event: `DOCUMENT_ADDED`.
No new infrastructure.

---

## V4 — Background Job Durability

**The fine-tuning phase item from `build_sequence.md`.**

Replace `p-queue` (in-process, lost on restart) with a durable job queue.

**What this teaches:**

- **Job queues fundamentals** — the difference between a message queue (fire-and-forget),
  a job queue (at-least-once delivery with retry), and a task queue (exactly-once with
  deduplication). You'll learn why in-process queues are fine for V1 and where they break.
- **`pg-boss`** — Postgres-backed job queue that shares your existing DB connection.
  Jobs are rows in a `pgboss.*` schema. No new infrastructure — your existing Postgres
  is the queue. This is the right choice before you need Redis.
- **Idempotency** — if a job is retried after a partial failure, it must not insert
  duplicate chunks, duplicate summaries, or double-charge a user. Designing for idempotency
  means adding `idempotencyKey` checks to every job handler.
- **Dead letter queues** — what happens to a job that fails five times? You need a place
  to park it, inspect it, and decide whether to retry or discard. This is an operational
  concept that V1 never forces you to think about.

**Stack changes:** `pg-boss`. New `src/jobs/` folder. The `process-uploaded-documents`
pipeline becomes a job handler rather than a fire-and-forget async call.

---

## V4 — Real-Time Status with SSE

**Noted in `progress.md` under "Future consideration".**

Replace polling (`GET /api/sessions/:id` every N seconds) with Server-Sent Events.

**What this teaches:**

- **SSE vs WebSocket** — SSE is unidirectional (server → client), uses a plain HTTP
  connection, and works through load balancers without special configuration. WebSocket
  is bidirectional and stateful. For a status feed, SSE is the correct choice. Understanding
  *why* is the point.
- **Effect streaming primitives** — Effect's `HttpServerResponse` has first-class support
  for streaming responses. You'll learn how to convert an Effect `Stream` into an SSE
  response without manual `res.write()` calls.
- **Fan-out** — if two browser tabs have the same session open, both need updates.
  A naive implementation breaks: the SSE connection is per-process and per-client.
  V4 introduces the idea of a pub/sub layer (even if you solve it with Postgres `LISTEN/NOTIFY`
  instead of Redis).

**Stack changes:** New streaming endpoint on the existing Effect HttpApi server. Postgres
`LISTEN/NOTIFY` as the simplest pub/sub. No new services if you stay in Postgres.

---

## V5 — Horizontal Scaling + Production Infrastructure

**The cluster of topics V1 deliberately defers.**

Make the app runnable on more than one server process simultaneously.

**What this teaches:**

- **Stateless services** — the current server holds XState machines in memory. A second
  process has no idea about them. Making the server stateless means every request must
  reload XState from the Postgres snapshot. You already have the snapshot mechanism —
  the challenge is making the load path fast enough.
- **Connection pooling** — `postgres.js` opens connections directly. Under load, this
  exhausts the Postgres connection limit. PgBouncer (a connection pool proxy) sits in
  front of Postgres and multiplexes connections. You'll learn why this is necessary,
  what transaction vs session pooling modes mean, and where prepared statements break
  under pooling.
- **Load balancing** — Kubernetes or plain Nginx round-robins requests across instances.
  Sticky sessions are not needed (stateless design). You'll learn what a rolling deploy
  is and why it requires your DB schema changes to be backward-compatible.
- **Database read replicas** — writes go to the primary; reads (session status checks, chunk
  retrieval) can go to a replica. Drizzle supports multiple connections. The challenge is
  understanding replication lag and when it is safe to read from a replica.
- **Secrets management** — `.env` files don't work in Kubernetes. You'll learn how to
  use environment variable injection from a secrets store (Kubernetes Secrets, AWS SSM,
  or Vault) and why the interface is the same regardless of which one you use.

**Stack changes:** Docker image build. Kubernetes manifests or AWS ECS task definitions.
PgBouncer in the Docker Compose stack. CI/CD pipeline (GitHub Actions).

---

## V5 — Multimodal Intake

**The audio stretch goal from `project_description.md`.**

Accept voice memos and transcribe them before analysis.

**What this teaches:**

- **Audio processing pipeline** — file upload → transcription → chunking → embedding.
  This adds a new document type (`audio`) and a new parser (Whisper API or a local model).
  The rest of the pipeline is unchanged.
- **Streaming transcription** — Whisper returns a transcript with timestamps. You can
  chunk by speaker turn or by time window rather than by character count. This is a
  different chunking strategy than the current recursive character splitter.
- **Cost accounting** — audio transcription is priced per minute, not per token. You'll
  want to store transcription cost alongside LLM token cost in Langfuse so you can reason
  about per-session cost.

**Stack changes:** New parser in `src/agent/parsers.ts`. New `audio` value in the
`document_type` enum. Vercel AI SDK's `transcribe()` function or direct Whisper API call.

---

## V6 — Eval Suite Expansion

**The eval module from `project_description.md`, taken further.**

Move from 5 planted-issue tests to a systematic eval framework.

**What this teaches:**

- **LLM-as-judge patterns** — faithfulness (did the agent invent requirements?),
  completeness (did it miss anything important?), and conflict-detection (did it surface
  the planted contradiction?) are three different eval shapes. Each requires a different
  judge prompt and a different scoring rubric.
- **Regression testing for AI** — a code change that improves conflict detection might
  degrade faithfulness. Running the full eval suite on every PR is the only way to catch
  this. You'll learn how to wire Langfuse evals into a CI pipeline.
- **Golden dataset curation** — 10 test cases is a starting point. 50 is a corpus.
  You'll learn what makes a good eval case (covers an edge, has an unambiguous ground
  truth, exercises a specific failure mode) and what makes a bad one.
- **Evals as a product spec** — if you can describe the failure modes precisely enough
  to write an eval for them, you've understood the problem. The eval-writing exercise
  often reveals design gaps that were invisible before.

**Stack changes:** Expanded `docs/test_corpus/`. New `src/evals/` folder. Langfuse
dataset API for storing golden inputs/outputs. No new infrastructure.

---

## Concept map: what each V teaches you

| Concept | V1 | V2 | V3 | V4 | V5 | V6 |
|---|---|---|---|---|---|---|
| LLM structured output | core | | | | | |
| RAG fundamentals | core | | | | | |
| Prompt engineering | core | | | | | |
| HITL agent loop | core | | | | | |
| XState (sequential) | core | | | | | |
| Effect-TS (errors, DI) | core | | | | | |
| Streaming output | core | | | | | |
| LLM observability (Langfuse) | core | extended | | | | extended |
| Multi-agent contracts | | core | | | | |
| XState parallel states | | core | | | | |
| MCP server authoring | | core | | | | |
| Authentication (OAuth, sessions) | | | core | | | |
| Row-level security | | | core | | | |
| Semantic diffing | | | core | | | |
| Job queues + idempotency | | | | core | | |
| SSE / pub-sub | | | | core | | |
| Stateless service design | | | | | core | |
| Connection pooling | | | | | core | |
| Load balancing + rolling deploys | | | | | core | |
| Secrets management | | | | | core | |
| Eval suite design | | | | | | core |
| CI eval pipelines | | | | | | core |

---

## Order of priority (tutor's view)

The natural order, considering learning value and effort:

1. **V2 Multi-agent split** — highest learning density, zero new infrastructure,
   builds directly on what Phase 3 taught you about the pipeline shape.
2. **V3 Auth + multi-tenancy** — unblocked once drizzle hits stable 1.0. Everything
   real-world uses auth; you've deferred it long enough.
3. **V4 Background jobs + SSE** — makes the app production-ready without cloud infra.
   `pg-boss` is the single most useful backend pattern you aren't using yet.
4. **V2 Coding agent handoff** — high fun factor, teaches MCP from first principles.
5. **V3 Versioning + diff** — the schema is already designed for it; mostly a UI problem.
6. **V5 Horizontal scaling** — only meaningful when you have users. Don't build this early.
7. **V5 Multimodal intake** — a nice demo feature; lower learning density than the others.
8. **V6 Eval expansion** — do this in parallel with any V2+ work, not as a dedicated phase.
