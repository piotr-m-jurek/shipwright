/**
 * Phase 5b gate test — output export + revision loop.
 * Runs a full session through to complete, then tests:
 *   - GET /output/:type/download-url returns a working presigned URL
 *   - POST /revise triggers re-generation producing version 2
 *
 * Usage: pnpm tsx src/agent/test-phase5b-gate.ts
 * Requires: server on port 3000, ANTHROPIC_API_KEY set
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env") });

import { readFile } from "fs/promises";
import { Layer, ManagedRuntime } from "effect";
import { StorageAdapter } from "../storage/index.js";
import { db } from "../db/index.js";
import { agentSessions, outputs } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createAgentSession, createDocument, createChunks } from "../db/queries.js";
import { parseDocument } from "./parsers.js";
import { estimateTokenCount } from "./estimate-token-count.js";
import { ConfigService } from "../config.js";

const runtime = ManagedRuntime.make(Layer.provideMerge(StorageAdapter.layer, ConfigService.layer));
const CORPUS = resolve(process.cwd(), "docs/test_corpus");
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

console.log("\n=== Phase 5b Gate Test ===\n");

// ── 1. Setup session ────────────────────────────────────────────────────────
console.log("1. Setup session + corpus chunks");
const files = [
  { filename: "project_brief.txt", documentType: "notes" as const },
  { filename: "prd_draft.md", documentType: "prd_draft" as const },
  { filename: "rfp.md", documentType: "rfp" as const },
  { filename: "discovery_call_transcript.txt", documentType: "transcript" as const },
];

const session = await createAgentSession({ status: "processing" });
const sessionId = session.id;

for (const { filename, documentType } of files) {
  const buf = await readFile(resolve(CORPUS, filename));
  const parsed = await runtime.runPromise(parseDocument(buf, filename));
  const doc = await createDocument({
    sessionId,
    filename,
    documentType,
    mimeType: "text/plain",
    sizeBytes: buf.length,
    status: "ready",
    tokenCount: estimateTokenCount(parsed.text),
  });
  await createChunks([
    {
      sessionId,
      documentId: doc.id,
      documentType,
      content: parsed.text,
      chunkIndex: 0,
      charOffset: 0,
      embedding: new Array(1536).fill(0),
    },
  ]);
}
ok(`Session: ${sessionId}`);

// ── 2. Run through to complete ─────────────────────────────────────────────
console.log("\n2. Running full pipeline to complete...");
await req("POST", `/sessions/${sessionId}/confirm`);

const awaiting = await poll(sessionId, "awaiting_answers");
if (!awaiting) {
  fail("Never reached awaiting_answers");
  process.exit(1);
}
ok(`awaiting_answers (${awaiting.questions?.length} questions)`);

// Submit answers — two rounds to hit roundLimitReached
const qs = awaiting.questions as { id: string }[];
await req("POST", `/sessions/${sessionId}/answers`, {
  answers: qs.map((q: any) => ({ questionId: q.id, text: "Confirmed, proceed as described." })),
});

const awaiting2 = await poll(sessionId, "awaiting_answers", 15000);
if (awaiting2) {
  const qs2 = awaiting2.questions as { id: string }[];
  await req("POST", `/sessions/${sessionId}/answers`, {
    answers: qs2.map((q: any) => ({ questionId: q.id, text: "Round 2 confirmation." })),
  });
  ok("Round 2 submitted");
}

console.log("\n   Waiting for writer passes (~60s)...");
const complete = await poll(sessionId, "complete");
if (!complete) {
  fail("Never reached complete");
  process.exit(1);
}
ok("Session reached complete");

// ── 3. Verify initial outputs in DB ────────────────────────────────────────
console.log("\n3. Initial output checks");
const outputRows = await db.select().from(outputs).where(eq(outputs.sessionId, sessionId));
const briefV1 = outputRows.find((o) => o.type === "project_brief" && o.version === 1);
const prdV1 = outputRows.find((o) => o.type === "implementation_prd" && o.version === 1);

if (briefV1?.s3Key) {
  ok(`project_brief v1 has s3Key: ${briefV1.s3Key}`);
} else {
  fail("project_brief v1 missing s3Key", briefV1);
}

if (prdV1?.s3Key) {
  ok(`implementation_prd v1 has s3Key: ${prdV1.s3Key}`);
} else {
  fail("implementation_prd v1 missing s3Key");
}

// ── 4. Export — download-url endpoint ──────────────────────────────────────
console.log("\n4. Export via presigned URL");

const briefUrlRes = (await req(
  "GET",
  `/sessions/${sessionId}/output/project_brief/download-url`,
)) as any;
if (briefUrlRes.status === 200 && briefUrlRes.body?.url?.startsWith("http")) {
  ok("GET /output/project_brief/download-url returns URL");

  // Fetch the URL directly — must return the Brief content
  const fileRes = await fetch(briefUrlRes.body.url);
  if (fileRes.ok) {
    const content = await fileRes.text();
    if (content.length > 100) {
      ok(`Presigned URL resolves to Brief content (${content.length} chars)`);
    } else {
      fail("Presigned URL returned empty/short content", content.length);
    }
  } else {
    fail("Presigned URL fetch failed", fileRes.status);
  }
} else {
  fail("GET /output/project_brief/download-url", briefUrlRes);
}

const prdUrlRes = (await req(
  "GET",
  `/sessions/${sessionId}/output/implementation_prd/download-url`,
)) as any;
if (prdUrlRes.status === 200 && prdUrlRes.body?.url?.startsWith("http")) {
  ok("GET /output/implementation_prd/download-url returns URL");
} else {
  fail("GET /output/implementation_prd/download-url", prdUrlRes);
}

// Invalid type returns 404
const badTypeRes = (await req("GET", `/sessions/${sessionId}/output/bad_type/download-url`)) as any;
if (badTypeRes.status === 404) {
  ok("Invalid type returns 404");
} else {
  fail("Invalid type should return 404", badTypeRes.status);
}

// ── 5. Revision loop ────────────────────────────────────────────────────────
console.log("\n5. Revision loop");

const reviseRes = (await req("POST", `/sessions/${sessionId}/revise`, {
  feedback:
    "Please add more detail about the BambooHR integration in both the Brief and the PRD acceptance criteria.",
})) as any;

if (reviseRes.status === 200 && reviseRes.body?.started === true) {
  ok("POST /revise returns { started: true }");
} else {
  fail("POST /revise", JSON.stringify(reviseRes));
}

// Machine should be in revising or generating
await new Promise((r) => setTimeout(r, 500));
const revisingCheck = (await req("GET", `/sessions/${sessionId}`)) as any;
const revState = revisingCheck.body?.status;
if (["revising", "generating", "complete"].includes(revState)) {
  ok(`Machine in ${revState} after REVISION_REQUESTED`);
} else {
  fail("Machine not in expected state after revision", revState);
}

// Wait for complete again (revision writers take ~60s)
console.log("\n   Waiting for revision writers (~60s)...");
const complete2 = await poll(sessionId, "complete");
if (!complete2) {
  fail("Never reached complete after revision");
  process.exit(1);
}
ok("Session reached complete after revision");

// Check version 2 exists
const outputRowsAfter = await db.select().from(outputs).where(eq(outputs.sessionId, sessionId));
const briefV2 = outputRowsAfter.find((o) => o.type === "project_brief" && o.version === 2);
const prdV2 = outputRowsAfter.find((o) => o.type === "implementation_prd" && o.version === 2);

if (briefV2?.content && briefV2.content.length > 100) {
  ok(`project_brief v2 stored (${briefV2.content.length} chars)`);
} else {
  fail("project_brief v2 missing or empty");
}

if (prdV2?.content && prdV2.content.length > 100) {
  ok(`implementation_prd v2 stored (${prdV2.content.length} chars)`);
} else {
  fail("implementation_prd v2 missing or empty");
}

// outputVersion in xstateSnapshot should be 2
const [sessionRow] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
const outputVersion = (sessionRow.xstateSnapshot as any)?.context?.outputVersion;
if (outputVersion === 2) {
  ok("outputVersion = 2 in xstateSnapshot");
} else {
  fail("outputVersion not 2", outputVersion);
}

// GET /output returns v2 content
const outputV2Res = (await req("GET", `/sessions/${sessionId}/output`)) as any;
if (outputV2Res.body?.version === 2) {
  ok("GET /sessions/:id/output returns version 2");
} else {
  fail("GET /sessions/:id/output wrong version", outputV2Res.body?.version);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
console.log("Test session cleaned up.");
process.exit(failed > 0 ? 1 : 0);
