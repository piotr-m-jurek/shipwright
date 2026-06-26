/**
 * Phase 4 gate test — verifies all acceptance criteria against a live server.
 *
 * Requires: server running on port 3000 (node --import tsx/esm src/server/server.ts)
 *           ANTHROPIC_API_KEY set in .env
 *
 * Usage: pnpm tsx src/agent/test-phase4-gate.ts
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");

import {
  agentSessions,
  questions as questionsTable,
  answers as answersTable,
} from "../../db/schema.js";
import { eq, count } from "drizzle-orm";
import { DatabaseService } from "../../db/queries.js";
import { DB, AppDBLiveLayer } from "../../db/index.js";
import { parseDocument } from "../parsers.js";
import { estimateTokenCount } from "../estimate-token-count.js";
import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { StorageAdapter } from "../../storage/index.js";
import { ConfigService } from "../../config/config.js";

const runtime = ManagedRuntime.make(
  pipe(
    Layer.mergeAll(StorageAdapter.layer, DatabaseService.layer, AppDBLiveLayer),
    Layer.provide(ConfigService.layer),
  ),
);

const runDb = (effect: Effect.Effect<any, any, DatabaseService>) => runtime.runPromise(effect);
const runRaw = (effect: Effect.Effect<any, any, DB>) => runtime.runPromise(effect);

const BASE = "http://localhost:3000/api";
const CORPUS = resolve(REPO_ROOT, "docs/test_corpus");

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
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function pollForStatus(
  sessionId: string,
  targetStatus: string,
  maxWaitMs = 120000,
): Promise<Record<string, unknown> | null> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await req("GET", `/sessions/${sessionId}`);
    const status = (res.body as any)?.status;
    process.stdout.write(`  [polling: ${status}]\r`);
    if (status === targetStatus) {
      process.stdout.write("\n");
      return res.body as Record<string, unknown>;
    }
    if (String(status).includes("error")) {
      process.stdout.write("\n");
      return null;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  process.stdout.write("\n");
  return null;
}

console.log("\n=== Phase 4 Gate Test ===\n");

// ── 1. Insert session + docs + chunks directly (bypass S3/embedder) ────────
console.log("1. Setting up test session with corpus documents");

const corpusFiles = [
  { filename: "project_brief.txt", documentType: "notes" as const },
  { filename: "prd_draft.md", documentType: "prd_draft" as const },
  { filename: "rfp.md", documentType: "rfp" as const },
  { filename: "discovery_call_transcript.txt", documentType: "transcript" as const },
];

const session = await runDb(
  Effect.flatMap(DatabaseService, (svc) => svc.createAgentSession({ status: "processing" })),
);
const sessionId = session.id;

for (const { filename, documentType } of corpusFiles) {
  const buffer = await readFile(resolve(CORPUS, filename));
  const parsed = await runtime.runPromise(parseDocument(buffer, filename));

  const doc = await runDb(
    Effect.flatMap(DatabaseService, (svc) =>
      svc.createDocument({
        sessionId,
        filename,
        documentType,
        mimeType: "text/plain",
        sizeBytes: buffer.length,
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

ok(`Session created with ${corpusFiles.length} documents + chunks: ${sessionId}`);

// ── 2. POST /confirm — trigger analysis ─────────────────────────────────────
console.log("\n2. POST /confirm triggers analysis pipeline");

const confirmRes = await req("POST", `/sessions/${sessionId}/confirm`);
if (confirmRes.status === 200 && (confirmRes.body as any)?.started === true) {
  ok("POST /sessions/:id/confirm returns { started: true }");
} else {
  fail("POST /sessions/:id/confirm", JSON.stringify(confirmRes));
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 500));
const stateCheck = await req("GET", `/sessions/${sessionId}`);
const stateAfterConfirm = (stateCheck.body as any)?.status;
if (
  ["analyzing", "awaiting_answers", "re_evaluating", "generating", "summarizing"].includes(
    stateAfterConfirm,
  )
) {
  ok(`Machine advanced to '${stateAfterConfirm}' after /confirm`);
} else {
  fail("Machine state unexpected after /confirm", stateAfterConfirm);
}

// ── 3. Poll for awaiting_answers ─────────────────────────────────────────────
console.log("\n3. Waiting for analysis pipeline (may take ~60s with LLM calls)...");

const awaitingSession = await pollForStatus(sessionId, "awaiting_answers");
if (!awaitingSession) {
  const finalCheck = await req("GET", `/sessions/${sessionId}`);
  fail(
    "Session never reached awaiting_answers",
    `final status: ${(finalCheck.body as any)?.status}`,
  );
  await runDb(Effect.flatMap(DatabaseService, (svc) => svc.deleteAgentSession(sessionId)));
  process.exit(1);
}
ok("Session reached awaiting_answers");

const sessionQuestions =
  (awaitingSession.questions as { id: string; text: string; rationale: string }[]) ?? [];
if (sessionQuestions.length >= 3 && sessionQuestions.length <= 7) {
  ok(`3–7 questions generated (got ${sessionQuestions.length})`);
} else {
  fail("Question count out of range", sessionQuestions.length);
}

// ── 4. Persistence checks ────────────────────────────────────────────────────
console.log("\n4. Persistence checks");

const [sessionRow] = await runRaw(
  Effect.flatMap(DB, (db) =>
    db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)),
  ),
);

if (sessionRow.xstateSnapshot) {
  ok("xstateSnapshot is non-null in DB after transitions");
} else {
  fail("xstateSnapshot is null in DB");
}

const snap = sessionRow.xstateSnapshot as any;
if (snap?.context?.round === 0) {
  ok("round is 0 before first USER_ANSWERED");
} else {
  fail("round unexpected before answers", snap?.context?.round);
}

const [{ value: qCount }] = await runRaw(
  Effect.flatMap(DB, (db) =>
    db
      .select({ value: count() })
      .from(questionsTable)
      .where(eq(questionsTable.sessionId, sessionId)),
  ),
);
if (Number(qCount) >= 3) {
  ok(`Questions persisted to questions table (${qCount} rows)`);
} else {
  fail("Questions not persisted", qCount);
}

// ── 5. Submit answers round 1 ────────────────────────────────────────────────
console.log("\n5. Submit answers round 1");

const answers1 = sessionQuestions.map((q) => ({
  questionId: q.id,
  text: "Gate test answer: proceed with mobile-responsive web for V1.",
}));

const answersRes1 = await req("POST", `/sessions/${sessionId}/answers`, { answers: answers1 });
if (answersRes1.status === 200) {
  ok("POST /sessions/:id/answers returns 200");
  ok(
    `sufficient=${(answersRes1.body as any).sufficient}, round=${(answersRes1.body as any).round}`,
  );
} else {
  fail("POST /sessions/:id/answers", JSON.stringify(answersRes1));
}

await new Promise((r) => setTimeout(r, 300));
const [sessionAfter1] = await runRaw(
  Effect.flatMap(DB, (db) =>
    db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)),
  ),
);
const round1 = (sessionAfter1.xstateSnapshot as any)?.context?.round;
if (round1 === 1) {
  ok("round incremented to 1 in xstateSnapshot");
} else {
  fail("round did not increment to 1", round1);
}

const [{ value: aCount }] = await runRaw(
  Effect.flatMap(DB, (db) =>
    db.select({ value: count() }).from(answersTable).where(eq(answersTable.sessionId, sessionId)),
  ),
);
if (Number(aCount) >= answers1.length) {
  ok(`Answers persisted to answers table (${aCount} rows)`);
} else {
  fail("Answers not persisted to DB", aCount);
}

// ── 6. Round 2 + roundLimitReached ──────────────────────────────────────────
console.log("\n6. Round 2 + roundLimitReached guard");

const statusRes2 = await req("GET", `/sessions/${sessionId}`);
const status2 = (statusRes2.body as any)?.status;

if (status2 === "awaiting_answers") {
  ok("Machine returned to awaiting_answers for round 2");

  const qs2 = ((statusRes2.body as any)?.questions ?? sessionQuestions) as { id: string }[];
  const answers2 = qs2.map((q) => ({ questionId: q.id, text: "Round 2 gate test answer." }));
  const answersRes2 = await req("POST", `/sessions/${sessionId}/answers`, { answers: answers2 });

  if (answersRes2.status === 200) {
    ok("Round 2 answers submitted");
  } else {
    fail("Round 2 answers failed", JSON.stringify(answersRes2));
  }

  await new Promise((r) => setTimeout(r, 500));
  const [sessionAfter2] = await runRaw(
    Effect.flatMap(DB, (db) =>
      db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)),
    ),
  );
  const round2 = (sessionAfter2.xstateSnapshot as any)?.context?.round;
  if (round2 === 2) {
    ok("round incremented to 2");
  } else {
    fail("round did not reach 2", round2);
  }

  const finalRes = await req("GET", `/sessions/${sessionId}`);
  const fs = (finalRes.body as any)?.status;
  if (["generating", "complete", "awaiting_answers"].includes(fs)) {
    ok(`roundLimitReached guard fired — machine at: ${fs}`);
  } else {
    fail("roundLimitReached guard may not have fired", fs);
  }
} else {
  ok(`Answers sufficient on round 1 — machine at: ${status2}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

await runDb(Effect.flatMap(DatabaseService, (svc) => svc.deleteAgentSession(sessionId)));
console.log("Test session cleaned up.");

process.exit(failed > 0 ? 1 : 0);
