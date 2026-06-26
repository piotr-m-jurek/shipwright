/**
 * Phase 5 gate test — verifies writer passes produce valid outputs stored in DB.
 * Runs the full pipeline end-to-end through to complete state.
 *
 * Usage: pnpm tsx src/agent/test-phase5-gate.ts
 * Requires: server running on port 3000, ANTHROPIC_API_KEY set
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");

import { readFile } from "fs/promises";
import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { StorageAdapter } from "../../storage/index.js";
import { DB, AppDBLiveLayer } from "../../db/index.js";
import { DatabaseService } from "../../db/queries.js";
import { outputs } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { parseDocument } from "../parsers.js";
import { estimateTokenCount } from "../estimate-token-count.js";
import { ConfigService } from "../../config/config.js";

const runtime = ManagedRuntime.make(
  pipe(
    Layer.mergeAll(StorageAdapter.layer, DatabaseService.layer, AppDBLiveLayer),
    Layer.provide(ConfigService.layer),
  ),
);

const runDb = (effect: Effect.Effect<any, any, DatabaseService>) => runtime.runPromise(effect);
const runRaw = (effect: Effect.Effect<any, any, DB>) => runtime.runPromise(effect);

const CORPUS = resolve(REPO_ROOT, "docs/test_corpus");
const BASE = "http://localhost:3000/api";

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  ✓ ${label}`);
  passed++;
}
function fail(label: string, detail?: unknown) {
  console.error(`  ❌ ${label}`, detail ?? "");
  failed++;
}

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: res.status, body: await res.text() };
  }
}

async function poll(sessionId: string, target: string, maxMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = (await req("GET", `/sessions/${sessionId}`)) as any;
    const s = r.body?.status;
    process.stdout.write(`  [${s}]\r`);
    if (s === target) {
      process.stdout.write("\n");
      return r.body;
    }
    if (String(s).includes("error")) {
      process.stdout.write("\n");
      return null;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  process.stdout.write("\n");
  return null;
}

console.log("\n=== Phase 5 Gate Test ===\n");

// ── Setup: insert session + corpus chunks ──────────────────────────────────
console.log("1. Setting up test session");

const files = [
  { filename: "project_brief.txt", documentType: "notes" as const },
  { filename: "prd_draft.md", documentType: "prd_draft" as const },
  { filename: "rfp.md", documentType: "rfp" as const },
  { filename: "discovery_call_transcript.txt", documentType: "transcript" as const },
];

const session = await runDb(
  Effect.flatMap(DatabaseService, (svc) => svc.createAgentSession({ status: "processing" })),
);
const sessionId = session.id;

for (const { filename, documentType } of files) {
  const buf = await readFile(resolve(CORPUS, filename));
  const parsed = await runtime.runPromise(parseDocument(buf, filename));
  const doc = await runDb(
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
  await runDb(
    Effect.flatMap(DatabaseService, (svc) =>
      svc.createChunks([
        {
          sessionId,
          documentId: doc.id,
          documentType,
          content: parsed.text,
          chunkIndex: 0,
          charOffset: 0,
          embedding: new Array(1536).fill(0),
        },
      ]),
    ),
  );
}
ok(`Session created: ${sessionId}`);

// ── Trigger pipeline ───────────────────────────────────────────────────────
console.log("\n2. Triggering pipeline");
await req("POST", `/sessions/${sessionId}/confirm`);
ok("POST /confirm sent");

// ── Wait for awaiting_answers ──────────────────────────────────────────────
console.log("\n3. Waiting for analysis (~60s)...");
const awaitingSession = await poll(sessionId, "awaiting_answers");
if (!awaitingSession) {
  fail("Never reached awaiting_answers");
  process.exit(1);
}
ok(`awaiting_answers with ${awaitingSession.questions?.length} questions`);

// ── Submit answers (sufficient round) ─────────────────────────────────────
console.log("\n4. Submitting answers");
const qs = awaitingSession.questions as { id: string }[];
const answers1 = qs.map((q: { id: string }) => ({
  questionId: q.id,
  text: "Confirmed — proceed with this approach.",
}));
const ans1 = (await req("POST", `/sessions/${sessionId}/answers`, { answers: answers1 })) as any;
ok(`Round 1 answered — sufficient: ${ans1.body.sufficient}, round: ${ans1.body.round}`);

if (!ans1.body.sufficient) {
  const statusR2 = await poll(sessionId, "awaiting_answers", 10000);
  if (statusR2) {
    const qs2 = (statusR2.questions ?? qs) as { id: string }[];
    const answers2 = qs2.map((q: { id: string }) => ({
      questionId: q.id,
      text: "Confirmed for round 2.",
    }));
    await req("POST", `/sessions/${sessionId}/answers`, { answers: answers2 });
    ok("Round 2 answers submitted (roundLimitReached will fire)");
  }
}

// ── Wait for complete ──────────────────────────────────────────────────────
console.log("\n5. Waiting for writer passes (~60s)...");
const completeSession = await poll(sessionId, "complete");
if (!completeSession) {
  fail("Never reached complete");
  process.exit(1);
}
ok("Session reached complete");

// ── Verify outputs in DB ───────────────────────────────────────────────────
console.log("\n6. Verifying outputs");

const outputRows = await runRaw(
  Effect.flatMap(DB, (db) => db.select().from(outputs).where(eq(outputs.sessionId, sessionId))),
);
const brief = outputRows.find((o: (typeof outputRows)[number]) => o.type === "project_brief");
const prd = outputRows.find((o: (typeof outputRows)[number]) => o.type === "implementation_prd");

if (brief?.content && brief.content.length > 100) {
  ok(`project_brief stored (${brief.content.length} chars, version ${brief.version})`);
} else {
  fail("project_brief missing or too short", brief?.content?.length);
}

if (prd?.content && prd.content.length > 100) {
  ok(`implementation_prd stored (${prd.content.length} chars, version ${prd.version})`);
} else {
  fail("implementation_prd missing or too short", prd?.content?.length);
}

if (brief?.version === 1) {
  ok("version = 1 on first generation");
} else {
  fail("version is not 1", brief?.version);
}

if (brief?.content) {
  const hasOverview = brief.content.includes("## Overview") || brief.content.includes("## What");
  const hasOutOfScope = brief.content.toLowerCase().includes("scope");
  if (hasOverview && hasOutOfScope) {
    ok("Brief contains expected Markdown sections");
  } else {
    fail("Brief missing expected sections", { hasOverview, hasOutOfScope });
  }
}

if (prd?.content) {
  const hasAC = prd.content.includes("Acceptance Criteria");
  const hasNonGoal =
    prd.content.toLowerCase().includes("non-goal") ||
    prd.content.toLowerCase().includes("out of scope");
  const hasStack =
    prd.content.toLowerCase().includes("stack") || prd.content.toLowerCase().includes("technolog");
  if (hasAC && hasNonGoal && hasStack) {
    ok("PRD contains acceptance criteria, non-goals, and stack sections");
  } else {
    fail("PRD missing required sections", { hasAC, hasNonGoal, hasStack });
  }
}

const outputRes = (await req("GET", `/sessions/${sessionId}/output`)) as any;
if (outputRes.status === 200 && outputRes.body.projectBrief && outputRes.body.implementationPrd) {
  ok("GET /sessions/:id/output returns both outputs");
} else {
  fail("GET /sessions/:id/output missing content", outputRes.status);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

await runDb(Effect.flatMap(DatabaseService, (svc) => svc.deleteAgentSession(sessionId)));
console.log("Test session cleaned up.");

process.exit(failed > 0 ? 1 : 0);
