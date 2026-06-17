# Project Description Agent — Architecture Rules

> **Scope:** Non-negotiable invariants. The tutor checks these before reviewing
> anything else. A violation of any rule is a blocker regardless of phase.

---

## Rule 1 — Vercel AI SDK is the only LLM interface

**Never** import or call `@anthropic-ai/sdk` directly anywhere in the codebase
except in the provider registration file.

```
// ✅ Allowed — provider registration only
import { anthropic } from '@ai-sdk/anthropic'
const model = anthropic('claude-sonnet-4-5')

// ❌ Blocked — anywhere in the codebase
import Anthropic from '@anthropic-ai/sdk'
const client = new Anthropic()
client.messages.create(...)
```

**Why:** Provider flexibility. Switching to GPT-4o or Gemini must be a one-line
change, not a refactor across multiple files.

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

## Rule 6 — generateObject for structured passes, streamText for writing passes

The choice between `generateObject` and `streamText` is not arbitrary.

- `generateObject` → Extractor, Challenger, Question generator (structured JSON output)
- `streamText` → Brief writer, PRD writer (streaming Markdown to the client)

```
// ✅ Allowed
const analysis = await generateObject({ model, schema: DocumentAnalysisSchema, ... })
const stream = streamText({ model, system: briefPrompt, ... })

// ❌ Blocked
const { text } = await generateText({ model, ... })
const parsed = JSON.parse(text) // manual JSON parsing from generateText
```

**Why:** `generateObject` enforces the schema contract. `generateText` with manual
JSON parsing has no validation and will silently produce invalid data.

---

## Rule 7 — toDataStreamResponse is the only streaming transport

All streaming HTTP responses must use Vercel AI SDK's `toDataStreamResponse()`.
No custom SSE, no `ReadableStream` constructed by hand, no `res.write()` loops.

```
// ✅ Allowed
const stream = streamText({ model, ... })
return stream.toDataStreamResponse()

// ❌ Blocked
res.setHeader('Content-Type', 'text/event-stream')
res.write(`data: ${chunk}\n\n`) // manual SSE
```

**Why:** `useChat` on the frontend expects the Vercel AI SDK data stream protocol.
Custom SSE will not be parsed correctly by the frontend.

---

## Rule 8 — Never call agent passes directly from Hono routes

Agent passes (Extractor, Challenger, etc.) must only be invoked from within XState
actors. Hono routes send events to the XState machine — they never call agent
functions directly.

```
// ✅ Allowed — route sends event, machine calls the agent
app.post('/api/sessions/:id/stream', async (c) => {
  machine.send({ type: 'START_ANALYSIS' })
  return new Response(...)
})

// ❌ Blocked — route calls agent directly, bypassing the machine
app.post('/api/sessions/:id/stream', async (c) => {
  const result = await runExtractor(docs) // bypasses XState
  return c.json(result)
})
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

## Rule 10 — The Hono RPC client (hc) is the only HTTP client on the frontend

Frontend code must not construct `fetch` calls to the Hono API manually. All API
calls go through the typed `hc<typeof app>` client.

```ts
// ✅ Allowed
const client = hc<typeof app>("http://localhost:3000");
const res = await client.api.sessions.$post({ form: { file } });

// ❌ Blocked
const res = await fetch("http://localhost:3000/api/sessions", {
  method: "POST",
  body: formData,
});
```

**Why:** Manual fetch calls lose type safety. The Hono RPC client ensures that
request and response shapes are verified at compile time.

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
