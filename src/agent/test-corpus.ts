/**
 * Integration test — runs the Phase 3 pipeline against the test corpus.
 *
 * Usage:
 *   pnpm test:corpus
 *
 * Requires: ANTHROPIC_API_KEY set in .env
 *
 * Pipeline:
 *   parse corpus files → insert session + documents + chunks into DB
 *   → summarizeAllDocuments → getFinalSummariesBySession → runChallenger
 *
 * Gate checks:
 * - 5 final rows in document_summaries
 * - Every final summary has a non-empty sourceDocument
 * - At least one conflict with documentA and documentB populated
 * - At least one gap
 * - All 5 planted issues surfaced
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(process.cwd(), ".env") });

import { Layer, ManagedRuntime } from "effect";
import { runChallenger } from "./challenger.js";
import { parseDocument } from "./parsers.js";
import { summarizeAllDocuments } from "./summarizer.js";
import { estimateTokenCount } from "./estimate-token-count.js";
import {
  createAgentSession,
  createDocument,
  createChunks,
  getFinalSummariesBySession,
  DatabaseService,
} from "../db/queries.js";
import { StorageAdapter } from "../storage/index.js";
import { db } from "../db/index.js";
import { agentSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { ConfigService } from "../config.js";

const runtime = ManagedRuntime.make(
  Layer.mergeAll(StorageAdapter.layer, ConfigService.layer, DatabaseService.layer) as Layer.Layer<
    StorageAdapter | ConfigService | DatabaseService,
    never,
    never
  >,
);

const CORPUS_DIR = resolve(process.cwd(), "docs/test_corpus");

const CORPUS_FILES: {
  filename: string;
  documentType: "transcript" | "prd_draft" | "rfp" | "notes";
}[] = [
  { filename: "project_brief.txt", documentType: "notes" },
  { filename: "prd_draft.md", documentType: "prd_draft" },
  { filename: "rfp.md", documentType: "rfp" },
  { filename: "discovery_call_transcript.txt", documentType: "transcript" },
  { filename: "hr_requirements.pdf", documentType: "notes" },
];

async function main() {
  console.log("Setting up test session...");

  // Create a session
  const session = await createAgentSession({ status: "processing" });
  const sessionId = session.id;
  console.log(`Session: ${sessionId}`);

  try {
    // Parse each file, insert document + one chunk per document into DB
    console.log("\nParsing corpus and inserting records...");
    for (const { filename, documentType } of CORPUS_FILES) {
      const buffer = await readFile(resolve(CORPUS_DIR, filename));
      const parsed = await runtime.runPromise(parseDocument(buffer, filename));

      const doc = await createDocument({
        sessionId,
        filename,
        documentType,
        mimeType: "text/plain",
        sizeBytes: buffer.length,
        status: "ready",
        tokenCount: estimateTokenCount(parsed.text),
      });

      // Insert the full parsed text as a single chunk (bypasses embedder —
      // summarizer reads chunks from DB, not embeddings)
      await createChunks([
        {
          sessionId,
          documentId: doc.id,
          documentType,
          content: parsed.text,
          chunkIndex: 0,
          charOffset: 0,
          // embedding is required by the schema — use a zero vector for the test
          embedding: Array.from<number>({ length: 1536 }).fill(0),
        },
      ]);

      console.log(`  ✓ ${filename} (${parsed.text.length} chars)`);
    }

    // Run summarizer
    console.log("\nRunning summarizer...");
    await runtime.runPromise(summarizeAllDocuments(sessionId));

    // Verify DB gate
    const finals = await getFinalSummariesBySession(sessionId);

    console.log("\n── SUMMARIZER OUTPUT ───────────────────────────────────────");
    console.log(`Final summaries in DB: ${finals.length}`);

    if (finals.length !== CORPUS_FILES.length) {
      console.error(
        `❌ GATE FAIL: Expected ${CORPUS_FILES.length} final summaries, got ${finals.length}`,
      );
    } else {
      console.log(`✓ ${finals.length} final summaries stored`);
    }

    const missingSources = finals.filter((s) => !s.sourceDocument);
    if (missingSources.length > 0) {
      console.error(`❌ GATE FAIL: ${missingSources.length} summaries missing sourceDocument`);
    } else {
      console.log("✓ All summaries have sourceDocument");
    }

    finals.forEach((s) => {
      const itemCount = s.requirements.length + s.constraints.length + s.assumptions.length;
      console.log(
        `  ${s.sourceDocument}: ${itemCount} items (${s.requirements.length} req, ${s.constraints.length} con, ${s.assumptions.length} ass)`,
      );
    });

    // Run challenger
    console.log("\nRunning Challenger...");
    const gapReport = await runtime.runPromise(runChallenger(finals));

    console.log("\n── CHALLENGER OUTPUT ───────────────────────────────────────");
    console.log(`Conflicts:    ${gapReport.conflicts.length}`);
    console.log(`Gaps:         ${gapReport.gaps.length}`);
    console.log(`Ambiguities:  ${gapReport.ambiguities.length}`);

    const wellFormedConflicts = gapReport.conflicts.filter((c) => c.documentA && c.documentB);
    if (wellFormedConflicts.length > 0) {
      console.log(
        `✓ Found ${wellFormedConflicts.length} conflict(s) with both documentA and documentB`,
      );
    } else {
      console.error("❌ GATE FAIL: No conflicts with both documentA and documentB");
    }

    if (gapReport.gaps.length > 0) {
      console.log(`✓ Found ${gapReport.gaps.length} gap(s)`);
    } else {
      console.error("❌ GATE FAIL: No gaps found");
    }

    // ── Planted issue checks ───────────────────────────────────────────────
    console.log("\n── PLANTED ISSUE CHECKS ────────────────────────────────────");

    // Issue 1: mobile scope conflict (prd_draft.md vs transcript)
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
    // Checks requirements, constraints, AND assumptions — the summarizer may classify it
    // in any of these depending on phrasing. Also checks gaps, conflicts, ambiguities.
    const euResidency =
      finals.some(
        (s) =>
          s.sourceDocument.includes("rfp") &&
          [...s.requirements, ...s.constraints, ...s.assumptions].some(
            (i) =>
              i.text.toLowerCase().includes("eu") ||
              i.text.toLowerCase().includes("residency") ||
              i.text.toLowerCase().includes("european"),
          ),
      ) ||
      gapReport.gaps.some(
        (g) =>
          g.description.toLowerCase().includes("eu") ||
          g.description.toLowerCase().includes("residency"),
      ) ||
      gapReport.conflicts.some((c) => c.description.toLowerCase().includes("residency")) ||
      gapReport.ambiguities.some(
        (a) =>
          a.description.toLowerCase().includes("eu") ||
          a.description.toLowerCase().includes("residency"),
      );
    console.log(
      euResidency
        ? "✓ Issue 2 FOUND: EU data residency surfaced"
        : "❌ Issue 2 MISSING: EU data residency not surfaced from rfp.md",
    );

    // Issue 3: delegation gap
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

    // Issue 5: SSO conflict (prd_draft.md vs hr_requirements.pdf)
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

    const issuesPassed = [
      mobileConflict,
      euResidency,
      delegationGap,
      notificationAmbiguity,
      ssoConflict,
    ].filter(Boolean).length;
    console.log(`\nPlanted issues surfaced: ${issuesPassed}/5`);
    if (issuesPassed < 5) {
      console.log("⚠  Phase 8 gate requires all 5 issues surfaced.");
    } else {
      console.log("✓ All planted issues surfaced — Phase 3 gate criteria met.");
    }

    // ── Full output ────────────────────────────────────────────────────────
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
  } finally {
    // Clean up — delete the test session and all cascade-deleted records
    await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    console.log("\nTest session cleaned up.");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
