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
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env") });

import { runExtractor } from "./extractor.js";
import { runChallenger } from "./challenger.js";

const CORPUS_DIR = resolve(process.cwd(), "docs/test_corpus");

async function loadCorpus() {
  const files = [
    { filename: "project_brief.txt" },
    { filename: "prd_draft.md" },
    { filename: "rfp.md" },
    { filename: "discovery_call_transcript.txt" },
  ];

  return Promise.all(
    files.map(async ({ filename }) => ({
      filename,
      text: await readFile(resolve(CORPUS_DIR, filename), "utf-8"),
    })),
  );
}

async function main() {
  console.log("Loading test corpus...");
  const documents = await loadCorpus();
  console.log(`Loaded ${documents.length} documents.\n`);

  // ── Extractor ──────────────────────────────────────────────────────────────
  console.log("Running Extractor...");
  const analysis = await runExtractor(documents);

  console.log("\n── EXTRACTOR OUTPUT ────────────────────────────────────────");
  console.log(`Requirements: ${analysis.requirements.length}`);
  console.log(`Constraints:  ${analysis.constraints.length}`);
  console.log(`Assumptions:  ${analysis.assumptions.length}`);

  // Gate check: zero requirements without sourceDocument
  const allItems = [
    ...analysis.requirements,
    ...analysis.constraints,
    ...analysis.assumptions,
  ];
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
    console.error(`❌ GATE FAIL: Only ${analysis.requirements.length} requirements found (need ≥3)`);
  }

  console.log("\nSample requirements:");
  analysis.requirements.slice(0, 3).forEach((r) => {
    console.log(`  [${r.confidence}] ${r.text}`);
    console.log(`    source: ${r.sourceDocument}`);
  });

  // ── Challenger ─────────────────────────────────────────────────────────────
  console.log("\nRunning Challenger...");
  const gapReport = await runChallenger(documents, analysis);

  console.log("\n── CHALLENGER OUTPUT ───────────────────────────────────────");
  console.log(`Conflicts:    ${gapReport.conflicts.length}`);
  console.log(`Gaps:         ${gapReport.gaps.length}`);
  console.log(`Ambiguities:  ${gapReport.ambiguities.length}`);

  // Gate check: at least one conflict with documentA and documentB
  const wellFormedConflicts = gapReport.conflicts.filter(
    (c) => c.documentA && c.documentB,
  );
  if (wellFormedConflicts.length > 0) {
    console.log(`✓ Found ${wellFormedConflicts.length} conflict(s) with both documentA and documentB`);
  } else {
    console.error("❌ GATE FAIL: No conflicts with both documentA and documentB");
  }

  // Gate check: at least one gap
  if (gapReport.gaps.length > 0) {
    console.log(`✓ Found ${gapReport.gaps.length} gap(s)`);
  } else {
    console.error("❌ GATE FAIL: No gaps found");
  }

  if (gapReport.conflicts.length > 0) {
    console.log("\nConflicts found:");
    gapReport.conflicts.forEach((c) => {
      console.log(`  "${c.description}"`);
      console.log(`    A: ${c.documentA}`);
      console.log(`    B: ${c.documentB}`);
    });
  }

  if (gapReport.gaps.length > 0) {
    console.log("\nGaps found:");
    gapReport.gaps.slice(0, 3).forEach((g) => {
      console.log(`  [${g.affectedArea}] ${g.description}`);
    });
  }

  console.log("\nFull output written to stdout. Done.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
