/**
 * One-shot helper: creates a session + corpus chunks, triggers /confirm,
 * then waits until awaiting_answers and prints the session ID and question IDs.
 * Used for the server restart recovery gate test.
 *
 * Usage: node --env-file=.env --import tsx/esm src/agent/tests/restart-test-setup.ts
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ChunkIndex } from "@shipwright/shared/domain/value-objects";
import { StorageAdapter } from "@shipwright/storage";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { DB, AppDBLiveLayer } from "@shipwright/db";
import { users } from "@shipwright/db/schema";
import { parseDocument } from "../parsers";
import { estimateTokenCount } from "../lib/estimate-token-count";
import { ConfigService } from "@shipwright/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../");

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    StorageAdapter.layer,
    ConfigService.layer,
    AgentSessionRepository.layer,
    DocumentRepository.layer,
    ChunkRepository.layer,
    AppDBLiveLayer,
  ) as Layer.Layer<StorageAdapter | ConfigService | AgentSessionRepository | DocumentRepository | ChunkRepository | DB, never, never>,
);

const db = (effect: Effect.Effect<any, any, AgentSessionRepository | DocumentRepository | ChunkRepository>) => runtime.runPromise(effect);
const dbRaw = (effect: Effect.Effect<any, any, DB>) => runtime.runPromise(effect);

const TEST_USER_ID = "test-user-restart";

async function insertTestUser() {
  await dbRaw(
    Effect.flatMap(DB, (d) =>
      d
        .insert(users)
        .values({
          id: TEST_USER_ID,
          name: "Test User",
          email: "test-restart@shipwright.local",
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing(),
    ),
  );
}

const CORPUS = resolve(REPO_ROOT, "docs/test_corpus");
const BASE = "http://localhost:3000/api";

const files = [
  { filename: "project_brief.txt" },
  { filename: "prd_draft.md" },
  { filename: "rfp.md" },
  { filename: "discovery_call_transcript.txt" },
];

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : null,
  });
  return res.json();
}

console.log("Creating session + inserting corpus chunks...");
await insertTestUser();
const session = await db(
  Effect.flatMap(AgentSessionRepository, (svc) =>
    svc.createAgentSession({ status: "processing", userId: TEST_USER_ID }),
  ),
);
const sessionId = session.id;

for (const { filename } of files) {
  const buf = await readFile(resolve(CORPUS, filename));
  const parsed = await runtime.runPromise(parseDocument(buf, filename));
  const doc = await db(
    Effect.flatMap(DocumentRepository, (svc) =>
      svc.createDocument({
        sessionId,
        filename,
        mimeType: "text/plain",
        sizeBytes: buf.length,
        status: "ready",
        tokenCount: estimateTokenCount(parsed.text),
      }),
    ),
  );
  await db(
    Effect.flatMap(ChunkRepository, (svc) =>
      svc.createChunks([
        {
          sessionId,
          documentId: doc.id,
          content: parsed.text,
          chunkIndex: ChunkIndex.make(0),
          charOffset: 0,
          embedding: Array.from<number>({ length: 1024 }).fill(0),
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
