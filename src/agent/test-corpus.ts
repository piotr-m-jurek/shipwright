/**
 * Manual integration test — runs Extractor and Challenger against the test corpus.
 *
 * Usage:
 *   npx tsx src/agent/test-corpus.ts
 *
 * Requires: ANTHROPIC_API_KEY set in .env
 *
 * Gate checks verified by this script:
 * - Zero requirements without sourceDocument
 * - At least 3 distinct requirements
 * - At least one conflict with documentA and documentB populated
 * - At least one gap
 * - Planted contradiction: mobile scope (prd_draft.md vs discovery_call_transcript.txt)
 * - Planted contradiction: SSO auth (prd_draft.md vs hr_requirements.pdf)
 * - Planted gap: EU data residency buried in rfp.md
 * - Planted gap: delegation acceptance criteria missing from PRD
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env") });

import { Effect } from "effect";
import { runExtractor } from "./extractor.js";
import { runChallenger } from "./challenger.js";
import { parseDocument } from "./parsers.js";
import { runtime } from "../runtime.js";

const CORPUS_DIR = resolve(process.cwd(), "docs/test_corpus");

const CORPUS_FILES = [
  "project_brief.txt",
  "prd_draft.md",
  "rfp.md",
  "discovery_call_transcript.txt",
  "hr_requirements.pdf",
];

async function loadCorpus() {
  return Promise.all(
    CORPUS_FILES.map(async (filename) => {
      const buffer = await readFile(resolve(CORPUS_DIR, filename));
      const parsed = await runtime.runPromise(parseDocument(buffer, filename));
      return { filename, text: parsed.text };
    }),
  );
}

async function main() {
  console.log("Loading test corpus...");
  const documents = await loadCorpus();
  console.log(`Loaded ${documents.length} documents.\n`);

  // ── Extractor ──────────────────────────────────────────────────────────────
  console.log("Running Extractor...");
  const analysis = await runtime.runPromise(runExtractor(documents));

  console.log("\n── EXTRACTOR OUTPUT ────────────────────────────────────────");
  console.log(`Requirements: ${analysis.requirements.length}`);
  console.log(`Constraints:  ${analysis.constraints.length}`);
  console.log(`Assumptions:  ${analysis.assumptions.length}`);

  // Gate check: zero requirements without sourceDocument
  const allItems = [...analysis.requirements, ...analysis.constraints, ...analysis.assumptions];
  const missingSource = allItems.filter((item) => !item.sourceDocument);
  if (missingSource.length > 0) {
    console.error(`\n❌ GATE FAIL: ${missingSource.length} items missing sourceDocument:`);
    missingSource.forEach((item) => console.error(`  - ${item.text}`));
  } else {
    console.log("✓ All items have sourceDocument");
  }

  // Gate check: at least 3 distinct requirements
  if (analysis.requirements.length >= 3) {
    console.log(`✓ Found ${analysis.requirements.length} requirements (≥3)`);
  } else {
    console.error(
      `❌ GATE FAIL: Only ${analysis.requirements.length} requirements found (need ≥3)`,
    );
  }

  console.log("\nSample requirements:");
  analysis.requirements.slice(0, 3).forEach((r) => {
    console.log(`  [${r.confidence}] ${r.text}`);
    console.log(`    source: ${r.sourceDocument}`);
  });

  // ── Challenger ─────────────────────────────────────────────────────────────
  console.log("\nRunning Challenger...");
  const gapReport = await runtime.runPromise(runChallenger(documents, analysis));

  console.log("\n── CHALLENGER OUTPUT ───────────────────────────────────────");
  console.log(`Conflicts:    ${gapReport.conflicts.length}`);
  console.log(`Gaps:         ${gapReport.gaps.length}`);
  console.log(`Ambiguities:  ${gapReport.ambiguities.length}`);

  // Gate check: at least one conflict with documentA and documentB
  const wellFormedConflicts = gapReport.conflicts.filter((c) => c.documentA && c.documentB);
  if (wellFormedConflicts.length > 0) {
    console.log(
      `✓ Found ${wellFormedConflicts.length} conflict(s) with both documentA and documentB`,
    );
  } else {
    console.error("❌ GATE FAIL: No conflicts with both documentA and documentB");
  }

  // Gate check: at least one gap
  if (gapReport.gaps.length > 0) {
    console.log(`✓ Found ${gapReport.gaps.length} gap(s)`);
  } else {
    console.error("❌ GATE FAIL: No gaps found");
  }

  // ── Planted issue checks ───────────────────────────────────────────────────

  console.log("\n── PLANTED ISSUE CHECKS ────────────────────────────────────");

  // Issue 1: mobile scope contradiction (prd_draft.md vs discovery_call_transcript.txt)
  const mobileConflict = gapReport.conflicts.some(
    (c) =>
      (c.documentA.includes("prd_draft") || c.documentB.includes("prd_draft")) &&
      (c.documentA.includes("transcript") || c.documentB.includes("transcript")) &&
      c.description.toLowerCase().includes("mobile"),
  );
  console.log(
    mobileConflict
      ? "✓ Issue 1 FOUND: mobile scope conflict (prd_draft vs transcript)"
      : "❌ Issue 1 MISSING: mobile scope conflict not surfaced",
  );

  // Issue 2: EU data residency buried in rfp.md
  const euResidency =
    [...analysis.requirements, ...analysis.constraints].some(
      (i) => i.sourceDocument.includes("rfp") && i.text.toLowerCase().includes("eu"),
    ) ||
    gapReport.gaps.some((g) => g.description.toLowerCase().includes("eu") || g.description.toLowerCase().includes("residency")) ||
    gapReport.conflicts.some((c) => c.description.toLowerCase().includes("residency"));
  console.log(
    euResidency
      ? "✓ Issue 2 FOUND: EU data residency surfaced"
      : "❌ Issue 2 MISSING: EU data residency not surfaced from rfp.md",
  );

  // Issue 3: delegation acceptance criteria missing
  const delegationGap =
    gapReport.gaps.some((g) => g.description.toLowerCase().includes("delegat")) ||
    gapReport.conflicts.some((c) => c.description.toLowerCase().includes("delegat")) ||
    gapReport.ambiguities.some((a) => a.description.toLowerCase().includes("delegat"));
  console.log(
    delegationGap
      ? "✓ Issue 3 FOUND: delegation gap surfaced"
      : "❌ Issue 3 MISSING: delegation acceptance criteria gap not surfaced",
  );

  // Issue 4: notification channel ambiguity
  const notificationAmbiguity =
    gapReport.ambiguities.some((a) => a.description.toLowerCase().includes("notif")) ||
    gapReport.gaps.some((g) => g.description.toLowerCase().includes("notif")) ||
    gapReport.conflicts.some((c) => c.description.toLowerCase().includes("notif"));
  console.log(
    notificationAmbiguity
      ? "✓ Issue 4 FOUND: notification channel ambiguity surfaced"
      : "❌ Issue 4 MISSING: notification channel ambiguity not surfaced",
  );

  // Issue 5: SSO contradiction (prd_draft.md vs hr_requirements.pdf)
  const ssoConflict = gapReport.conflicts.some(
    (c) =>
      (c.documentA.includes("prd_draft") || c.documentB.includes("prd_draft")) &&
      (c.documentA.includes("hr_requirements") || c.documentB.includes("hr_requirements")) &&
      (c.description.toLowerCase().includes("sso") ||
        c.description.toLowerCase().includes("auth") ||
        c.description.toLowerCase().includes("azure")),
  );
  console.log(
    ssoConflict
      ? "✓ Issue 5 FOUND: SSO/auth conflict (prd_draft vs hr_requirements.pdf)"
      : "❌ Issue 5 MISSING: SSO/auth conflict not surfaced",
  );

  const issuesPassed = [mobileConflict, euResidency, delegationGap, notificationAmbiguity, ssoConflict].filter(Boolean).length;
  console.log(`\nPlanted issues surfaced: ${issuesPassed}/5`);
  if (issuesPassed < 5) {
    console.log("⚠  Phase 8 gate requires all 5 issues surfaced.");
  } else {
    console.log("✓ All planted issues surfaced — Phase 8 gate criteria met.");
  }

  // ── Full output ────────────────────────────────────────────────────────────

  if (gapReport.conflicts.length > 0) {
    console.log("\n── ALL CONFLICTS ───────────────────────────────────────────");
    gapReport.conflicts.forEach((c) => {
      console.log(`  "${c.description}"`);
      console.log(`    A: ${c.documentA}`);
      console.log(`    B: ${c.documentB}`);
    });
  }

  if (gapReport.gaps.length > 0) {
    console.log("\n── ALL GAPS ────────────────────────────────────────────────");
    gapReport.gaps.forEach((g) => {
      console.log(`  [${g.affectedArea}] ${g.description}`);
    });
  }

  if (gapReport.ambiguities.length > 0) {
    console.log("\n── ALL AMBIGUITIES ─────────────────────────────────────────");
    gapReport.ambiguities.forEach((a) => {
      console.log(`  [${a.sourceDocument}] ${a.description}`);
    });
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
