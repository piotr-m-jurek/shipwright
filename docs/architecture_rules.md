# Project Description Agent — Architecture Rules

> **Scope:** Non-negotiable invariants. The tutor checks these before reviewing
> anything else. A violation of any rule is a blocker regardless of phase.

---

## Rule 1 — `@effect/ai` is the only LLM interface

All LLM calls go through `LanguageModel` and `EmbeddingModel` from
`effect/unstable/ai`. Provider clients (`AnthropicClient`, `OpenAiClient`) are
registered once in `src/agent/providers.ts` and injected via `Layer`. No code
outside `providers.ts` imports a provider package directly.

```ts
// ✅ Allowed — provider registration in providers.ts only
import { AnthropicClient } from "@effect/ai-anthropic";
export const AnthropicClientLayer = ...

// ✅ Allowed — consuming the abstraction anywhere
import { LanguageModel } from "effect/unstable/ai";
yield* LanguageModel.generateObject({ schema, prompt })

// ❌ Blocked — importing a provider outside providers.ts
import { AnthropicLanguageModel } from "@effect/ai-anthropic"; // in challenger.ts
import Anthropic from "@anthropic-ai/sdk"; // anywhere
```

**Why:** Provider flexibility. Swapping Claude for GPT-4o or Gemini is a
one-layer change in `providers.ts`, not a refactor across every agent pass.
`@effect/ai`'s `LanguageModel` abstraction is strictly better for this than
the previous Vercel AI SDK approach — provider switching happens at the `Layer`
level, call sites are completely provider-agnostic.

---

## Rule 2 — mammoth always uses extractRawText, never convertToHtml

**Never** call `mammoth.convertToHtml()` for content that will be chunked or
embedded. HTML tags are semantically meaningless tokens that pollute embedding
vectors and degrade retrieval quality.

```
// ✅ Allowed
const { value } = await mammoth.extractRawText({ path: filePath })

// ❌ Blocked
const { value } = await mammoth.convertToHtml({ path: filePath })
// then chunking value — HTML tags will pollute the embeddings
```

**Why:** `<p>`, `<strong>`, `<ul>` add noise to the embedding space. The semantic
content is the text, not the markup.

---

## Rule 3 — Every structured output Zod schema requires sourceDocument on citations

Any Zod schema used in `generateObject` that produces requirements, constraints,
gaps, or conflicts **must** include a `sourceDocument` field that the model is
required to fill. Optional source fields defeat the purpose.

```
// ✅ Allowed
const RequirementSchema = z.object({
  text: z.string(),
  sourceDocument: z.string(), // required, not optional
  confidence: z.enum(['high', 'medium', 'low']),
})

// ❌ Blocked
const RequirementSchema = z.object({
  text: z.string(),
  sourceDocument: z.string().optional(), // optional = model will skip it
})
```

**Why:** Source citations are the anti-hallucination mechanism. Making them optional
means the model will frequently omit them when uncertain.

---

## Rule 4 — All file I/O goes through StorageAdapter

**Never** call `fs.writeFile`, `fs.readFile`, `fs.writeFileSync`, or any direct
filesystem operation outside of `src/storage/`. All file reads and writes use
`StorageAdapter`.

```
// ✅ Allowed
await storageAdapter.upload({ key: sessionId, body: fileBuffer })
const file = await storageAdapter.download({ key: sessionId })

// ❌ Blocked
await fs.writeFile(`./uploads/${sessionId}`, fileBuffer)
const file = await fs.readFile(`./uploads/${sessionId}`)
```

**Why:** The `StorageAdapter` interface makes the storage backend swappable.
Direct filesystem calls lock the code to local disk.

---

## Rule 5 — XState snapshot must be persisted on every state transition

After every XState transition, `xstateSnapshot` in the `sessions` table must be
updated. There is no acceptable delay or batching.

```
// ✅ Allowed — persisted immediately in the transition handler
machine.subscribe(async (snapshot) => {
  await db.update(sessions)
    .set({ xstateSnapshot: snapshot, status: snapshot.value })
    .where(eq(sessions.id, sessionId))
})

// ❌ Blocked — persisted only at "important" transitions
// Skipping intermediate states means the machine cannot be reliably rehydrated
```

**Why:** Session rehydration after a server restart depends on the snapshot being
current. Stale snapshots cause incorrect state restoration.

---

## Rule 6 — `LanguageModel.generateObject` for structured passes, `LanguageModel.streamText` for writing passes

The choice of output mode is not arbitrary.

- `LanguageModel.generateObject({ schema })` → Summarizer, Challenger, Question generator (structured output validated against an Effect `Schema.Struct`)
- `LanguageModel.streamText(...)` → Brief writer, PRD writer, Revision writer (streaming Markdown)

```ts
// ✅ Allowed — structured output via @effect/ai
yield* LanguageModel.generateObject({
  schema: GapReportEffectSchema,
  prompt: Prompt.make([...]),
})

// ✅ Allowed — streaming prose via @effect/ai
yield* LanguageModel.streamText({ prompt: Prompt.make([...]) })

// ❌ Blocked — manual JSON parsing
const text = yield* LanguageModel.generateText(...)
const parsed = JSON.parse(text) // no schema validation

// ❌ Blocked — Vercel AI SDK patterns (project no longer uses Vercel AI SDK)
const { output } = await generateText({ output: Output.object({ schema }) })
```

**Why:** `LanguageModel.generateObject` enforces the schema contract at the
`@effect/ai` level — the response is decoded through the Effect `Schema` and
a decode failure is a typed error, not a runtime crash. Manual JSON parsing
has no validation and will silently produce invalid data.

---

## Rule 7 — Effect HttpApi handles all HTTP transport

All HTTP endpoints are defined via Effect `HttpApiGroup`/`HttpApiEndpoint` and
implemented via `HttpApiBuilder.group`. No raw `http.createServer`, no manual
response construction, no custom SSE outside of Effect's streaming primitives.

```ts
// ✅ Allowed
class Api extends HttpApi.make("api").add(SystemApiGroup) {}
const handlers = HttpApiBuilder.group(Api, "system", (h) =>
  h.handle("myEndpoint", () => Effect.succeed(MyResponse.make({ ... })))
)

// ❌ Blocked — raw http or manual response construction
res.setHeader("Content-Type", "text/event-stream")
res.write(`data: ${chunk}\n\n`)
```

**Why:** The entire backend is Effect. All handlers are Effect generators; dependency
injection flows through `Layer`. Manual response construction bypasses the Effect
runtime and breaks type safety at the HTTP boundary.

---

## Rule 8 — Never call agent passes directly from HTTP handlers

Agent passes (Summarizer, Challenger, Question generator, Writers) must only be
invoked from within XState actors. HTTP handlers send events to the XState machine —
they never call agent functions directly.

```ts
// ✅ Allowed — handler sends event, machine calls the agent
h.handle("submitAnswers", ({ payload }) =>
  Effect.gen(function* () {
    yield* sendMachineEvent(sessionId, { type: "USER_ANSWERED", answers: payload.answers })
    return SubmitAnswersResponse.make({ ok: true })
  })
)

// ❌ Blocked — handler calls agent directly, bypassing the machine
h.handle("stream", () =>
  Effect.gen(function* () {
    const result = yield* runSummarizer(docs) // bypasses XState
    return result
  })
)
```

**Why:** The XState machine is the source of truth for session state. Bypassing it
means state transitions are not tracked, snapshots are not saved, and the machine
diverges from reality.

---

## Rule 9 — tokenCount is calculated at document insert, not at query time

`token_count` on the `documents` table must be calculated and stored when the
document is first processed, not computed on demand when the XState threshold
guard runs.

```
// ✅ Allowed — calculated once at insert
const tokenCount = estimateTokenCount(rawText)
await db.insert(documents).values({ ..., tokenCount })

// ❌ Blocked — calculated at guard evaluation time
const text = await db.select({ rawText: documents.rawText }).from(documents)...
const tokenCount = estimateTokenCount(text) // called every time the guard runs
```

**Why:** The threshold guard runs frequently. Re-computing token counts on demand
adds unnecessary latency and DB load.

---

## Rule 10 — Frontend uses a typed API client generated from the OpenAPI schema

Frontend code must not construct `fetch` calls manually. All API calls go through
a typed client derived from the Effect HttpApi OpenAPI schema (via `openapi-fetch`
or equivalent). The schema is exposed at `/openapi.json`.

```ts
// ✅ Allowed — typed client from OpenAPI schema
import createClient from "openapi-fetch"
import type { paths } from "./generated/api"
const client = createClient<paths>({ baseUrl: "http://localhost:3000" })
const { data } = await client.POST("/api/sessions/upload-url", { body: { files } })

// ❌ Blocked — raw fetch
const res = await fetch("http://localhost:3000/api/sessions/upload-url", {
  method: "POST",
  body: JSON.stringify({ files }),
})
```

**Why:** Manual fetch calls lose type safety. The typed client ensures request and
response shapes are verified at compile time against the same schema the server uses.

---

## Rule 11 — JSON columns in Drizzle schema must be typed with $type()

Never leave a `jsonb()` column as `unknown`. Use `.$type<T>()` to give it an
explicit TypeScript type.

```ts
// ✅ Allowed
xstateSnapshot: jsonb("xstate_snapshot").$type<MachineContext | null>();

// ❌ Blocked
xstateSnapshot: jsonb("xstate_snapshot"); // infers as unknown
```

**Why:** An untyped jsonb column means any code reading it must cast or
validate manually at every call site. A typed column makes the contract
explicit and catches shape mismatches at compile time.

---

## Rule 12 — File type must be verified from content, not just extension

Never trust file extension alone. Use `fileTypeFromStream` on the first bytes
of the file content to verify the MIME type matches the claimed extension
before passing to any parser.

```ts
// ✅ Allowed — verify content matches claimed type
const type = await fileTypeFromStream(partialStream);
if (type?.mime !== expectedMime) throw new UnsupportedFileTypeError();

// ❌ Blocked — trust extension alone
if (filename.endsWith(".txt")) parseAsText(buffer);
```

**Why:** A binary file renamed to `.txt` will crash or produce garbage output
in the parser. Content-based verification catches this before it reaches the
pipeline.

---

## Rule 14 — No cross-workspace relative imports

`apps/api` and `apps/web` must never import from each other or from
`packages/shared` using relative paths (`../../packages/shared/...`).
All cross-workspace imports use the package name.

```ts
// ✅ Allowed — package name import
import { DocumentSummarySchema } from "@shipwright/shared/schemas";
import type { MachineContext } from "@shipwright/shared/schemas/machine";

// ❌ Blocked — relative path crossing workspace boundary
import { DocumentSummarySchema } from "../../packages/shared/src/schemas/agent";
```

**Why:** Relative cross-workspace imports bypass the workspace resolution
protocol. They break when packages are reorganised, and they are invisible
to tools that reason about workspace dependency graphs (TypeScript project
references, pnpm, bundlers).

---

## Rule 15 — `query_chunks` tool execute function must filter by sessionId

Any `query_chunks` tool implementation must include `sessionId` as a required
filter on the pgvector query. A tool that queries across all sessions is a
data isolation bug.

```ts
// ✅ Allowed — sessionId filter ensures isolation
const chunks = await db
  .select()
  .from(chunksTable)
  .where(and(
    eq(chunksTable.sessionId, sessionId),
    sql`embedding <=> ${embedding} < ${SIMILARITY_THRESHOLD}`,
  ))
  .orderBy(sql`embedding <=> ${embedding}`)
  .limit(limit);

// ❌ Blocked — no sessionId filter, returns chunks from all sessions
const chunks = await db
  .select()
  .from(chunksTable)
  .orderBy(sql`embedding <=> ${embedding}`)
  .limit(limit);
```

**Why:** Sessions are isolated units. A query that bleeds across session
boundaries will return chunks from other users' documents, corrupting the
analysis and leaking data.

---

## Rule 13 — Analysis passes read chunks from DB, never raw document text

No Summarizer, Challenger, or Writer pass may read `documents.rawText`
directly and pass it as LLM input. All analysis passes load chunks from the `chunks`
table and work from them (or from per-document summaries derived from chunks).

```ts
// ✅ Allowed — load chunks from DB, pass to summarizer
const chunks = await db.select().from(chunksTable)
  .where(eq(chunksTable.documentId, docId))
  .orderBy(chunksTable.chunkIndex)
const { output } = await generateText({
  messages: [{ role: 'user', content: formatChunks(chunks) }],
  ...
})

// ❌ Blocked — passing rawText directly into an analysis LLM call
const doc = await db.select({ rawText: documents.rawText }).from(documents)...
const { output } = await generateText({
  messages: [{ role: 'user', content: doc.rawText }],
  ...
})
```

**Why:** Raw text is unbounded — a large document will exceed the context window
silently or require truncation, losing information without any visibility. Chunks are
already sized for context and carry metadata. The map-reduce summarization pass is
the correct escalation path for large documents.
