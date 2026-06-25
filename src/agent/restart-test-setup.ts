/**
 * One-shot helper: creates a session + corpus chunks, triggers /confirm,
 * then waits until awaiting_answers and prints the session ID and question IDs.
 * Used for the server restart recovery gate test.
 *
 * Usage: pnpm tsx src/agent/restart-test-setup.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env") });

import { readFile } from "fs/promises";
import { Effect, Layer, ManagedRuntime } from "effect";
import { StorageAdapter } from "../storage/index.js";
import { DatabaseService } from "../db/queries.js";
import { parseDocument } from "./parsers.js";
import { estimateTokenCount } from "./estimate-token-count.js";
import { ConfigService } from "../config.js";

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    StorageAdapter.layer,
    ConfigService.layer,
    DatabaseService.layer,
  ) as Layer.Layer<StorageAdapter | ConfigService | DatabaseService, never, never>,
);

const db = (effect: Effect.Effect<any, any, DatabaseService>) => runtime.runPromise(effect);

const CORPUS = resolve(process.cwd(), "docs/test_corpus");
const BASE = "http://localhost:3000/api";

const files = [
  { filename: "project_brief.txt", documentType: "notes" as const },
  { filename: "prd_draft.md", documentType: "prd_draft" as const },
  { filename: "rfp.md", documentType: "rfp" as const },
  { filename: "discovery_call_transcript.txt", documentType: "transcript" as const },
];

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

console.log("Creating session + inserting corpus chunks...");
const session = await db(
  Effect.flatMap(DatabaseService, (svc) => svc.createAgentSession({ status: "processing" })),
);
const sessionId = session.id;

for (const { filename, documentType } of files) {
  const buf = await readFile(resolve(CORPUS, filename));
  const parsed = await runtime.runPromise(parseDocument(buf, filename));
  const doc = await db(
    Effect.flatMap(DatabaseService, (svc) =>
      svc.createDocument({
        sessionId,
        filename,
        documentType,
        mimeType: "text/plain",
        sizeBytes: buf.length,
        status: "ready",
        tokenCount: estimateTokenCount(parsed.text),
      }),
    ),
  );
  await db(
    Effect.flatMap(DatabaseService, (svc) =>
      svc.createChunks([
        {
          sessionId,
          documentId: doc.id,
          documentType,
          content: parsed.text,
          chunkIndex: 0,
          charOffset: 0,
          embedding: Array.from<number>({ length: 1536 }).fill(0),
        },
      ]),
    ),
  );
}
console.log(`Session: ${sessionId}`);

console.log("Triggering analysis pipeline via POST /confirm...");
await req("POST", `/sessions/${sessionId}/confirm`);

console.log("Polling for awaiting_answers (this will take ~60s)...");
let questions: { id: string; text: string }[] = [];
const start = Date.now();
while (Date.now() - start < 120000) {
  const s = (await req("GET", `/sessions/${sessionId}`)) as any;
  process.stdout.write(`  [${s.status}]\r`);
  if (s.status === "awaiting_answers") {
    process.stdout.write("\n");
    questions = s.questions ?? [];
    break;
  }
  if (String(s.status).includes("error")) {
    process.stdout.write("\n");
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}

if (!questions.length) {
  console.error("Failed to reach awaiting_answers");
  process.exit(1);
}

console.log(`\n✓ Session is in awaiting_answers with ${questions.length} questions`);
console.log(`\nSession ID:   ${sessionId}`);
console.log(`Question IDs: ${questions.map((q) => q.id).join(", ")}`);
console.log(`\nNow kill the server, restart it, then run:`);
console.log(`  curl -s -X POST http://localhost:3000/api/sessions/${sessionId}/answers \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(
  `    -d '{"answers":[${questions
    .slice(0, 2)
    .map((q) => `{"questionId":"${q.id}","text":"restart recovery answer"}`)
    .join(",")}]}'`,
);
