/**
 * Phase 8 eval suite — three parts:
 *
 *   Part A: Conflict detection (deterministic — no LLM judge)
 *           Runs the corpus through summarizer + challenger and checks the
 *           GapReport against all 5 planted issues. Requires ANTHROPIC_API_KEY only.
 *
 *   Part B: Faithfulness eval (LLM-as-judge)
 *           Checks the Project Brief for hallucinated requirements.
 *           Requires a full pipeline run (Brief generated) and ANTHROPIC_API_KEY.
 *
 *   Part C: Completeness eval (LLM-as-judge)
 *           Checks the Implementation PRD for dropped requirements.
 *           Requires a full pipeline run (PRD generated) and ANTHROPIC_API_KEY.
 *
 * Usage:
 *   pnpm test:evals              — run all three parts
 *   pnpm test:evals --conflict-only  — run Part A only (no full pipeline needed)
 *
 * Requires: ANTHROPIC_API_KEY in apps/api/.env
 * Parts B+C also require a prior full session run with outputs in the DB,
 * or OpenAI embeddings to be working (for full pipeline in one shot).
 *
 * Exit code 0 = all requested parts pass. Exit code 1 = any failure.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");

import { Effect, Layer, ManagedRuntime, Option, pipe, Schema, Stream } from "effect";
import { DB, AppDBLiveLayer } from "../../db/index.js";
import { users } from "../../db/schema.js";
import { LanguageModel, Prompt, Response } from "effect/unstable/ai";
import { AnthropicLanguageModel } from "@effect/ai-anthropic";

import { runChallenger } from "../writers/challenger.ts";
import { parseDocument } from "../parsers.js";
import { summarizeAllDocuments } from "../writers/summarizer.ts";
import { estimateTokenCount } from "../lib/estimate-token-count.ts";
import { DbAgentSession } from "../../db/services/agent-session.ts";
import { DbDocument } from "../../db/services/document.ts";
import { DbChunk } from "../../db/services/chunk.ts";
import { DbSummary } from "../../db/services/summary.ts";
import { DbOutput } from "../../db/services/output.ts";
import { StorageAdapter } from "../../storage/index.js";
import { ConfigService } from "../../config/config.js";
import { AnthropicClientLayer } from "../providers.js";
import type { GapReportEffect } from "../schemas.js";
import type { ReconstructedSummary } from "../../db/services/summary.ts";
import { AgentSessionId } from "@shipwright/shared/domain/ids";

import {
  FaithfulnessEvalSchema,
  CompletenessEvalSchema,
} from "@shipwright/shared/schemas/evals.js";

// ── Runtime ────────────────────────────────────────────────────────────────

const runtime = ManagedRuntime.make(
  pipe(
    Layer.mergeAll(StorageAdapter.layer, DbAgentSession.layer, DbDocument.layer, DbChunk.layer, DbSummary.layer, DbOutput.layer, AppDBLiveLayer),
    Layer.provide(ConfigService.layer),
  ),
);

const TEST_USER_ID = "test-user-evals";

async function insertTestUser() {
  await runtime.runPromise(
    Effect.flatMap(DB, (db) =>
      db
        .insert(users)
        .values({
          id: TEST_USER_ID,
          name: "Test User",
          email: "test-evals@shipwright.local",
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing(),
    ),
  );
}

// ── Corpus setup ───────────────────────────────────────────────────────────

const CORPUS_DIR = resolve(REPO_ROOT, "docs/test_corpus");

const CORPUS_FILES: { filename: string }[] = [
  { filename: "project_brief.txt" },
  { filename: "prd_draft.md" },
  { filename: "rfp.md" },
  { filename: "discovery_call_transcript.txt" },
  { filename: "hr_requirements.pdf" },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function pass(label: string) {
  console.log(`  ✓ ${label}`);
}

function fail(label: string) {
  console.error(`  ✗ ${label}`);
}

async function runEffect<A>(
  effect: Effect.Effect<A, any, DbAgentSession | DbDocument | DbChunk | DbSummary | DbOutput | StorageAdapter>,
): Promise<A> {
  return runtime.runPromise(effect);
}

// ── Part A — Conflict detection (deterministic) ────────────────────────────

/**
 * 5 planted issues in the corpus. Each check returns true if the issue was
 * surfaced anywhere — in the GapReport OR in the per-document summaries.
 *
 * Issue 2 (EU data residency) is a "buried constraint" test: the planted issue
 * is whether the summarizer extracted it from rfp.md, not whether the challenger
 * flagged a cross-document conflict. Checking summaries directly is correct.
 */
function checkPlantedIssues(
  gapReport: GapReportEffect,
  summaries: ReconstructedSummary[],
): {
  results: { label: string; found: boolean }[];
  allFound: boolean;
} {
  const { conflicts, gaps, ambiguities } = gapReport;

  const euTerms = (text: string) =>
    text.toLowerCase().includes("eu") ||
    text.toLowerCase().includes("european union") ||
    text.toLowerCase().includes("residency") ||
    text.toLowerCase().includes("data region") ||
    text.toLowerCase().includes("gdpr") ||
    text.toLowerCase().includes("eu-region") ||
    text.toLowerCase().includes("eu region");

  // Issue 1: mobile scope conflict — prd_draft says out of scope, transcript says mandatory
  const issue1 = conflicts.some(
    (c) =>
      (c.documentA.includes("prd_draft") || c.documentB.includes("prd_draft")) &&
      (c.documentA.includes("transcript") || c.documentB.includes("transcript")) &&
      c.description.toLowerCase().includes("mobile"),
  );

  // Issue 2: EU data residency buried in rfp.md.
  // The planted test: did the summarizer extract it from rfp.md?
  // Check summaries first (correct signal), then fall back to gap report.
  const rfpSummary = summaries.find((s) => s.sourceDocument.includes("rfp"));
  const issue2 =
    (rfpSummary !== undefined &&
      [...rfpSummary.constraints, ...rfpSummary.requirements, ...rfpSummary.assumptions].some(
        (item) => euTerms(item.text),
      )) ||
    (rfpSummary?.summary !== undefined && euTerms(rfpSummary.summary)) ||
    conflicts.some((c) => euTerms(c.description)) ||
    gaps.some((g) => euTerms(g.description)) ||
    ambiguities.some((a) => euTerms(a.description));

  // Issue 3: delegation acceptance criteria gap — prd_draft lacks the spec from hr_requirements
  const issue3 =
    conflicts.some((c) => c.description.toLowerCase().includes("delegat")) ||
    gaps.some((g) => g.description.toLowerCase().includes("delegat")) ||
    ambiguities.some((a) => a.description.toLowerCase().includes("delegat"));

  // Issue 4: notification channel ambiguity — three-way inconsistency
  const issue4 =
    conflicts.some((c) => c.description.toLowerCase().includes("notif")) ||
    gaps.some((g) => g.description.toLowerCase().includes("notif")) ||
    ambiguities.some((a) => a.description.toLowerCase().includes("notif"));

  // Issue 5: SSO/auth conflict — prd_draft says email/password, hr_requirements says Azure AD mandatory
  const issue5 = conflicts.some(
    (c) =>
      (c.documentA.includes("prd_draft") || c.documentB.includes("prd_draft")) &&
      (c.documentA.includes("hr_requirements") || c.documentB.includes("hr_requirements")) &&
      (c.description.toLowerCase().includes("sso") ||
        c.description.toLowerCase().includes("auth") ||
        c.description.toLowerCase().includes("azure") ||
        c.description.toLowerCase().includes("saml")),
  );

  const results = [
    { label: "Issue 1: mobile scope conflict (prd_draft vs transcript)", found: issue1 },
    { label: "Issue 2: EU data residency buried in rfp.md", found: issue2 },
    { label: "Issue 3: delegation acceptance criteria gap", found: issue3 },
    { label: "Issue 4: notification channel ambiguity", found: issue4 },
    { label: "Issue 5: SSO/auth conflict (prd_draft vs hr_requirements)", found: issue5 },
  ];

  return { results, allFound: results.every((r) => r.found) };
}

async function runPartA(): Promise<boolean> {
  console.log("\n── Part A: Conflict detection (deterministic) ──────────────");

  await insertTestUser();

  const sessionId = await runEffect(
    Effect.flatMap(DbAgentSession, (db) =>
      db.createAgentSession({ status: "processing", userId: TEST_USER_ID }),
    ).pipe(Effect.map((s) => s.id)),
  );

  try {
    // Insert corpus with zero embeddings (Part A doesn't need retrieval)
    for (const { filename } of CORPUS_FILES) {
      const buffer = await readFile(resolve(CORPUS_DIR, filename));
      const parsed = await runtime.runPromise(parseDocument(buffer, filename));

      const doc = await runEffect(
        Effect.flatMap(DbDocument, (db) =>
          db.createDocument({
            sessionId,
            filename,
            mimeType: "text/plain",
            sizeBytes: buffer.length,
            status: "ready",
            tokenCount: estimateTokenCount(parsed.text),
          }),
        ),
      );

      await runEffect(
        Effect.flatMap(DbChunk, (db) =>
          db.createChunks([
            {
              sessionId,
              documentId: doc.id,
              content: parsed.text,
              chunkIndex: 0,
              charOffset: 0,
              embedding: Array.from<number>({ length: 1536 }).fill(0),
            },
          ]),
        ),
      );
    }

    console.log(`  Corpus inserted (${CORPUS_FILES.length} documents)`);
    console.log("  Running summarizer...");
    await runtime.runPromise(
      summarizeAllDocuments(sessionId).pipe(Effect.provide(AnthropicClientLayer)),
    );

    const summaries = await runEffect(
      Effect.flatMap(DbSummary, (db) => db.getFinalSummariesBySession(sessionId)),
    );

    if (summaries.length !== CORPUS_FILES.length) {
      fail(`Expected ${CORPUS_FILES.length} final summaries, got ${summaries.length}`);
      return false;
    }
    pass(`${summaries.length} final summaries produced`);

    console.log("  Running challenger...");
    const gapReport = await runtime.runPromise(
      runChallenger(summaries).pipe(Effect.provide(AnthropicClientLayer)),
    );

    console.log(
      `  GapReport: ${gapReport.conflicts.length} conflicts, ${gapReport.gaps.length} gaps, ${gapReport.ambiguities.length} ambiguities`,
    );

    const { results, allFound } = checkPlantedIssues(gapReport, summaries);
    for (const { label, found } of results) {
      found ? pass(label) : fail(label);
    }

    const count = results.filter((r) => r.found).length;
    console.log(`\n  Planted issues surfaced: ${count}/5`);
    return allFound;
  } finally {
    await runEffect(Effect.flatMap(DbAgentSession, (db) => db.deleteAgentSession(sessionId)));
  }
}

// ── Part B — Faithfulness eval (LLM-as-judge) ─────────────────────────────

const FaithfulnessJudgeSystemPrompt = `You are an independent requirements auditor evaluating a Project Brief for faithfulness.

You will receive:
1. A Project Brief produced by an AI agent
2. The source document summaries the Brief was generated from

Your job: identify any requirements, constraints, decisions, or claims in the Brief that are NOT traceable to the source summaries. These are hallucinations.

A claim is faithful if:
- It appears in at least one source summary's requirements, constraints, assumptions, or prose
- It is a reasonable synthesis of multiple source claims (cite both)
- It explicitly says something is unclear or unknown

A claim is hallucinated if:
- It is specific (a number, a technology, a deadline, a policy) but not present in any source
- It contradicts source material

Score 0.0–1.0 where 1.0 = completely faithful, 0.0 = heavily hallucinated.
Pass threshold: score >= 0.9

Respond with JSON matching exactly this structure:
{
  "hallucinatedRequirements": [{ "text": "...", "reason": "..." }],
  "result": { "score": 0.0-1.0, "reasoning": "...", "pass": true/false, "citations": [] }
}`;

const sonnetModel = AnthropicLanguageModel.model("claude-sonnet-4-6");

async function runPartB(briefText: string, summaries: ReconstructedSummary[]): Promise<boolean> {
  console.log("\n── Part B: Faithfulness eval (LLM-as-judge) ───────────────");

  const summaryContext = summaries
    .map((s) => {
      const items = [
        ...s.requirements.map((r) => `  [req] ${r.text}`),
        ...s.constraints.map((c) => `  [constraint] ${c.text}`),
        ...s.assumptions.map((a) => `  [assumption] ${a.text}`),
      ].join("\n");
      return `=== ${s.sourceDocument} ===\n${s.summary}${items ? `\n${items}` : ""}`;
    })
    .join("\n\n");

  const userContent = `## Source Document Summaries\n\n${summaryContext}\n\n## Project Brief to Evaluate\n\n${briefText}`;

  const judgeEffect = LanguageModel.streamText({
    prompt: Prompt.make([
      { role: "system", content: FaithfulnessJudgeSystemPrompt },
      { role: "user", content: userContent },
    ]),
  }).pipe(
    Stream.filter((part): part is Response.TextDeltaPart => part.type === "text-delta"),
    Stream.map((part) => part.delta),
    Stream.runFold(
      () => "",
      (acc, delta) => acc + delta,
    ),
  );

  const rawJson = await runtime.runPromise(
    judgeEffect.pipe(Effect.provide(sonnetModel), Effect.provide(AnthropicClientLayer)),
  );

  // Strip markdown code fences if present
  const json = rawJson
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  const decode = Schema.decodeUnknownSync(FaithfulnessEvalSchema);
  const parsed = decode(JSON.parse(json));

  if (parsed.hallucinatedRequirements.length > 0) {
    console.log("  Hallucinations found:");
    for (const h of parsed.hallucinatedRequirements) {
      console.log(`    - "${h.text}" — ${h.reason}`);
    }
  } else {
    pass("No hallucinated requirements found");
  }

  const scorePassed = parsed.result.score >= 0.9;
  console.log(`  Score: ${parsed.result.score.toFixed(2)} — ${parsed.result.reasoning}`);
  scorePassed ? pass("Faithfulness eval PASSED") : fail("Faithfulness eval FAILED (score < 0.9)");

  return scorePassed;
}

// ── Part C — Completeness eval (LLM-as-judge) ─────────────────────────────

const CompletenessJudgeSystemPrompt = `You are an independent requirements auditor evaluating an Implementation PRD for completeness.

You will receive:
1. An Implementation PRD produced by an AI agent (written for a coding agent, not a human)
2. The source document summaries the PRD was generated from

Your job: identify important requirements, constraints, or assumptions from the source summaries that are NOT reflected anywhere in the PRD.

An item is "dropped" if:
- It is a concrete requirement, constraint, or assumption with implementation impact
- It is not mentioned in the PRD, not even implicitly
- Its omission would cause the coding agent to miss something important

Do NOT flag:
- Items that are explicitly listed as out of scope
- Items that are synthesised into more general PRD requirements
- Style or formatting differences

Score 0.0–1.0 where 1.0 = fully complete, 0.0 = critical items missing.
Pass threshold: score >= 0.9

Respond with JSON matching exactly this structure:
{
  "droppedItems": [{ "text": "...", "sourceDocument": "..." }],
  "result": { "score": 0.0-1.0, "reasoning": "...", "pass": true/false, "citations": [] }
}`;

async function runPartC(prdText: string, summaries: ReconstructedSummary[]): Promise<boolean> {
  console.log("\n── Part C: Completeness eval (LLM-as-judge) ────────────────");

  const summaryContext = summaries
    .map((s) => {
      const items = [
        ...s.requirements.map((r) => `  [req] ${r.text} (source: ${r.sourceDocument})`),
        ...s.constraints.map((c) => `  [constraint] ${c.text} (source: ${c.sourceDocument})`),
        ...s.assumptions.map((a) => `  [assumption] ${a.text} (source: ${a.sourceDocument})`),
      ].join("\n");
      return `=== ${s.sourceDocument} ===\n${s.summary}${items ? `\n${items}` : ""}`;
    })
    .join("\n\n");

  const userContent = `## Source Document Summaries\n\n${summaryContext}\n\n## Implementation PRD to Evaluate\n\n${prdText}`;

  const judgeEffect = LanguageModel.streamText({
    prompt: Prompt.make([
      { role: "system", content: CompletenessJudgeSystemPrompt },
      { role: "user", content: userContent },
    ]),
  }).pipe(
    Stream.filter((part): part is Response.TextDeltaPart => part.type === "text-delta"),
    Stream.map((part) => part.delta),
    Stream.runFold(
      () => "",
      (acc, delta) => acc + delta,
    ),
  );

  const rawJson = await runtime.runPromise(
    judgeEffect.pipe(Effect.provide(sonnetModel), Effect.provide(AnthropicClientLayer)),
  );

  const json = rawJson
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  const decode = Schema.decodeUnknownSync(CompletenessEvalSchema);
  const parsed = decode(JSON.parse(json));

  if (parsed.droppedItems.length > 0) {
    console.log("  Dropped items:");
    for (const d of parsed.droppedItems) {
      console.log(`    - "${d.text}" (from ${d.sourceDocument})`);
    }
  } else {
    pass("No dropped requirements found");
  }

  const scorePassed = parsed.result.score >= 0.9;
  console.log(`  Score: ${parsed.result.score.toFixed(2)} — ${parsed.result.reasoning}`);
  scorePassed ? pass("Completeness eval PASSED") : fail("Completeness eval FAILED (score < 0.9)");

  return scorePassed;
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

async function main() {
  const conflictOnly = process.argv.includes("--conflict-only");

  console.log("=== Phase 8 Eval Suite ===");
  if (conflictOnly) console.log("Mode: conflict detection only (--conflict-only)");

  const results: { part: string; passed: boolean }[] = [];

  // Part A always runs
  const partAPassed = await runPartA();
  results.push({ part: "A — conflict detection", passed: partAPassed });

  if (!conflictOnly) {
    // Parts B + C require existing outputs in DB from a prior full pipeline run.
    // Find the most recent complete session with both outputs.
    console.log("\n── Looking for existing complete session with outputs ────");

    // Accept a SESSION_ID env var pointing at an existing complete session
    const existingSessionId = process.env.EVAL_SESSION_ID;

    if (!existingSessionId) {
      console.log(
        "  Skipping Parts B+C: set EVAL_SESSION_ID=<id> to a complete session with outputs,",
      );
      console.log("  or run the full pipeline first and re-run evals.");
      console.log(
        "  Add EVAL_SESSION_ID to apps/api/.env or pass inline: EVAL_SESSION_ID=xxx pnpm test:evals",
      );
    } else {
      console.log(`  Using session: ${existingSessionId}`);

      const [briefRow, prdRow, summaries] = await Promise.all([
        runEffect(
          Effect.flatMap(DbOutput, (db) =>
            db.getLatestOutputByType({ sessionId: AgentSessionId.make(existingSessionId), type: "project_brief" }),
          ).pipe(Effect.map(Option.getOrUndefined)),
        ),
        runEffect(
          Effect.flatMap(DbOutput, (db) =>
            db.getLatestOutputByType({ sessionId: AgentSessionId.make(existingSessionId), type: "implementation_prd" }),
          ).pipe(Effect.map(Option.getOrUndefined)),
        ),
        runEffect(
          Effect.flatMap(DbSummary, (db) => db.getFinalSummariesBySession(AgentSessionId.make(existingSessionId))),
        ),
      ]);

      if (!briefRow?.content) {
        fail("No project_brief output found for this session");
        results.push({ part: "B — faithfulness", passed: false });
      } else {
        const partBPassed = await runPartB(briefRow.content, summaries);
        results.push({ part: "B — faithfulness", passed: partBPassed });
      }

      if (!prdRow?.content) {
        fail("No implementation_prd output found for this session");
        results.push({ part: "C — completeness", passed: false });
      } else {
        const partCPassed = await runPartC(prdRow.content, summaries);
        results.push({ part: "C — completeness", passed: partCPassed });
      }
    }
  }

  // Summary
  console.log("\n=== Results =============================================");
  let allPassed = true;
  for (const { part, passed } of results) {
    passed ? pass(`Part ${part}`) : fail(`Part ${part}`);
    if (!passed) allPassed = false;
  }

  await runtime.dispose();

  if (!allPassed) {
    console.error("\nEval suite FAILED — see above for details.");
    process.exit(1);
  }

  console.log("\nEval suite PASSED.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
