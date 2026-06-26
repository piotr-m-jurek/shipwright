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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");
config({ path: resolve(REPO_ROOT, ".env") });

import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { runChallenger } from "../challenger.js";
import { parseDocument } from "../parsers.js";
import { summarizeAllDocuments } from "../summarizer.js";
import { estimateTokenCount } from "../estimate-token-count.js";
import { DatabaseService } from "../../db/queries.js";
import { StorageAdapter } from "../../storage/index.js";
import { ConfigService } from "../../config/config.js";

const runtime = ManagedRuntime.make(
  pipe(
    Layer.mergeAll(StorageAdapter.layer, DatabaseService.layer),
    Layer.provide(ConfigService.layer),
  ),
);

function runDb<A>(effect: Effect.Effect<A, any, DatabaseService>): Promise<A> {
  return runtime.runPromise(effect);
}

const CORPUS_DIR = resolve(REPO_ROOT, "docs/test_corpus");

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

  const session = await runDb(
    Effect.flatMap(DatabaseService, (svc) => svc.createAgentSession({ status: "processing" })),
  );
  const sessionId = session.id;
  console.log(`Session: ${sessionId}`);

  try {
    console.log("\nParsing corpus and inserting records...");
    for (const { filename, documentType } of CORPUS_FILES) {
      const buffer = await readFile(resolve(CORPUS_DIR, filename));
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
              embedding: Array.from<number>({ length: 1536 }).fill(0),
            },
          ]),
        ),
      );

      console.log(`  ✓ ${filename} (${parsed.text.length} chars)`);
    }

    console.log("\nRunning summarizer...");
    await runtime.runPromise(summarizeAllDocuments(sessionId));

    const finals = await runDb(
      Effect.flatMap(DatabaseService, (svc) => svc.getFinalSummariesBySession(sessionId)),
    );

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

    console.log("\n── PLANTED ISSUE CHECKS ────────────────────────────────────");

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

    const delegationGap =
      gapReport.gaps.some((g) => g.description.toLowerCase().includes("delegat")) ||
      gapReport.conflicts.some((c) => c.description.toLowerCase().includes("delegat")) ||
      gapReport.ambiguities.some((a) => a.description.toLowerCase().includes("delegat"));
    console.log(
      delegationGap
        ? "✓ Issue 3 FOUND: delegation gap surfaced"
        : "❌ Issue 3 MISSING: delegation acceptance criteria gap not surfaced",
    );

    const notificationAmbiguity =
      gapReport.ambiguities.some((a) => a.description.toLowerCase().includes("notif")) ||
      gapReport.gaps.some((g) => g.description.toLowerCase().includes("notif")) ||
      gapReport.conflicts.some((c) => c.description.toLowerCase().includes("notif"));
    console.log(
      notificationAmbiguity
        ? "✓ Issue 4 FOUND: notification channel ambiguity surfaced"
        : "❌ Issue 4 MISSING: notification channel ambiguity not surfaced",
    );

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
    await runDb(Effect.flatMap(DatabaseService, (svc) => svc.deleteAgentSession(sessionId)));
    console.log("\nTest session cleaned up.");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
