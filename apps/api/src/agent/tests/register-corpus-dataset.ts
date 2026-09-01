/**
 * SHIP-153 — registers the test corpus as a Langfuse dataset.
 *
 * Usage:
 *   pnpm eval:register-dataset
 *
 * Requires: Langfuse configured (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY /
 * LANGFUSE_OTLP_ENDPOINT in .env). Does NOT require ANTHROPIC_API_KEY —
 * parsing the corpus files needs no LLM call.
 *
 * Idempotent: both the dataset and its item are upserted (by name, by id
 * respectively), so re-running this after editing the corpus or its ground
 * truth just updates the existing dataset/item in place.
 *
 * The five planted issues are currently one combined scenario (all five
 * corpus files together), not five independent cases, so today this creates
 * exactly one dataset item. If more corpus bundles are added under
 * docs/test_corpus_*, extend CORPUS_CASES below — each becomes its own item.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../../");

import { Effect, Layer, ManagedRuntime, pipe } from "effect";
import { ConfigService } from "@shipwright/config";
import { parseDocument } from "../parsers";
import { LangfuseClient } from "../../observability/langfuse-client";
import { FetchHttpClient } from "effect/unstable/http";
import { DATASET_NAME, CORPUS_CASE_ID } from "./eval-corpus";

const runtime = ManagedRuntime.make(
  pipe(
    LangfuseClient.layer.pipe(Layer.provide(FetchHttpClient.layer)),
    Layer.provide(ConfigService.layer),
  ),
);

// Ground truth mirrors docs/test_corpus/README.md — kept here (not derived
// from the README) so it's structured data a future eval script (SHIP-168)
// can diff a run's surfaced issues against, not prose a human has to re-read.
const PLANTED_ISSUES = [
  {
    id: "mobile-scope-conflict",
    category: "contradiction",
    where: "discovery_call_transcript.txt vs prd_draft.md",
    description:
      "Transcript: mobile is a hard requirement, in scope. PRD draft: mobile out of scope for V1, web only.",
  },
  {
    id: "eu-data-residency",
    category: "buried-constraint",
    where: "rfp.md paragraph 7",
    description:
      "EU data residency requirement (AWS eu-region only) buried under a generic compliance heading; not flagged in PRD draft or brief.",
  },
  {
    id: "delegation-acceptance-criteria",
    category: "missing-acceptance-criteria",
    where: "discovery_call_transcript.txt vs prd_draft.md vs hr_requirements.pdf",
    description:
      "Manager delegation is a core workflow per the transcript and has full acceptance criteria in hr_requirements.pdf, but the PRD draft lists it only as an open question.",
  },
  {
    id: "notification-channel-ambiguity",
    category: "ambiguous-requirement",
    where: "prd_draft.md + discovery_call_transcript.txt + hr_requirements.pdf",
    description:
      "PRD draft leaves the notification channel unspecified; transcript partially resolves it verbally; hr_requirements.pdf mandates email + in-app plus a 48-hour reminder, none of which made it back into the PRD.",
  },
  {
    id: "sso-auth-conflict",
    category: "contradiction",
    where: "prd_draft.md vs hr_requirements.pdf",
    description:
      "PRD draft: SSO/SAML out of scope, basic email/password auth for V1. hr_requirements.pdf: Azure AD SSO mandatory, no local accounts, non-negotiable.",
  },
] as const;

const CORPUS_CASES = [
  {
    id: CORPUS_CASE_ID,
    name: "Leave Management System (Synthetic)",
    dir: "docs/test_corpus",
    files: [
      "project_brief.txt",
      "prd_draft.md",
      "rfp.md",
      "discovery_call_transcript.txt",
      "hr_requirements.pdf",
    ],
    plantedIssues: PLANTED_ISSUES,
  },
] as const;

async function main() {
  console.log(`Registering dataset "${DATASET_NAME}"...`);
  await runtime.runPromise(
    Effect.flatMap(LangfuseClient, (client) =>
      client.createDataset({
        name: DATASET_NAME,
        description: "Synthetic project-input bundles with planted issues for agent eval gates.",
      }),
    ),
  );
  console.log("✓ Dataset ready\n");

  for (const testCase of CORPUS_CASES) {
    console.log(`Registering item "${testCase.id}"...`);

    const files = await Promise.all(
      testCase.files.map(async (filename) => {
        const buffer = await readFile(resolve(REPO_ROOT, testCase.dir, filename));
        const parsed = await runtime.runPromise(parseDocument(buffer, filename));
        return { filename, content: parsed.text };
      }),
    );

    await runtime.runPromise(
      Effect.flatMap(LangfuseClient, (client) =>
        client.createDatasetItem({
          datasetName: DATASET_NAME,
          id: testCase.id,
          input: { files },
          expectedOutput: { plantedIssues: testCase.plantedIssues },
          metadata: { name: testCase.name, sourceDir: testCase.dir },
        }),
      ),
    );

    console.log(`✓ Item "${testCase.id}" ready (${files.length} files, ${testCase.plantedIssues.length} planted issues)`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
