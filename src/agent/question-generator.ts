import { generateText, ModelMessage, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Effect } from "effect";
import {
  ClarifyingQuestionsSchema,
  GapReport,
  ClarifyingQuestions,
} from "../shared/schemas/agent.js";
import { TextGenerationError } from "./errors.js";
import { ReconstructedSummary } from "../db/queries.js";

const QuestionGeneratorSystemPrompt = `You are a requirements analyst preparing clarifying questions for a project team.

You will receive:
1. A gap report produced by a requirements reviewer — conflicts, gaps, and ambiguities found across project documents
2. Per-document summaries of the project documents

Your job is to produce a small set of targeted clarifying questions (3 to 7) that, when answered by the user, will resolve the most important blockers before writing the Project Brief and Implementation PRD.

RULES:
1. Select only 3 to 7 questions — never fewer than 3, never more than 7.
2. Rank by impact: unresolved conflicts that would make the output wrong come first, then gaps that would block implementation, then ambiguities.
3. Each question must be answerable by the user in 1–3 sentences. Do not ask for documents or research — ask for decisions.
4. sourceDocuments: list the exact filenames that surface this question. At least one required.
5. rationale: explain in one sentence why this question must be answered before writing outputs.
6. Do not ask about issues that can be reasonably assumed or inferred from the documents.
7. If fewer than 3 meaningful questions exist, still produce exactly 3 — ask about the most important open decisions.`;

export const runQuestionGenerator = Effect.fn("agent/runQuestionGenerator")(function* (
  gapReport: GapReport,
  summaries: ReconstructedSummary[],
): Effect.fn.Return<ClarifyingQuestions, TextGenerationError> {
  const userContent = formatInput(gapReport, summaries);
  const messages: ModelMessage[] = [{ role: "user", content: userContent }];

  const result = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model: anthropic("claude-haiku-4-5"),
        output: Output.object({ schema: ClarifyingQuestionsSchema }),
        system: QuestionGeneratorSystemPrompt,
        messages,
      }),
    catch: (cause) => new TextGenerationError({ cause }),
  });

  return result.output;
});

function formatInput(gapReport: GapReport, summaries: ReconstructedSummary[]): string {
  const summarySection = summaries
    .map((s) => `=== ${s.sourceDocument} ===\n${s.summary}`)
    .join("\n\n");

  const conflictsSection =
    gapReport.conflicts.length > 0
      ? gapReport.conflicts
          .map((c) => `- CONFLICT: ${c.description}\n  (${c.documentA} vs ${c.documentB})`)
          .join("\n")
      : "None";

  const gapsSection =
    gapReport.gaps.length > 0
      ? gapReport.gaps.map((g) => `- GAP [${g.affectedArea}]: ${g.description}`).join("\n")
      : "None";

  const ambiguitiesSection =
    gapReport.ambiguities.length > 0
      ? gapReport.ambiguities
          .map((a) => `- AMBIGUITY [${a.sourceDocument}]: ${a.description}`)
          .join("\n")
      : "None";

  return [
    "=== DOCUMENT SUMMARIES ===",
    summarySection,
    "",
    "=== GAP REPORT ===",
    "",
    "CONFLICTS:",
    conflictsSection,
    "",
    "GAPS:",
    gapsSection,
    "",
    "AMBIGUITIES:",
    ambiguitiesSection,
  ].join("\n");
}
