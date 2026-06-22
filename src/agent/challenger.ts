import { generateText, ModelMessage, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { GapReport, GapReportSchema } from "../shared/schemas/agent.js";
import { Effect } from "effect";
import { TextGenerationError } from "./errors.js";
import { ReconstructedSummary } from "../db/queries.js";

const ChallengerSystemPrompt = `You are an adversarial requirements reviewer. Your job is to find everything wrong, missing, or contradictory across a set of project document summaries.

You will receive one summary per document. Each summary contains:
- A prose overview of the document's content
- Extracted requirements, constraints, and assumptions — each attributed to its source document

Your job is to compare across all summaries and produce a structured gap report containing:

CONFLICTS: Places where two documents directly contradict each other. Both documentA and documentB are required — use the exact filenames from the summary headers. Do not flag a conflict unless you can cite both sides with their exact filenames.

GAPS: Requirements that are missing entirely — things the system clearly needs but that no document specifies. Focus on gaps that would block development or cause rework. A gap is not "this document is incomplete" — it is a specific missing specification.

AMBIGUITIES: Requirements that are mentioned but underspecified — where a developer would need to make an assumption to implement them. Cite the source document by exact filename.

RULES:
1. Be specific. Name the exact gap or contradiction — not a general observation about a document.
2. For conflicts, you must name both filenames involved using their exact names as they appear in the summary headers.
3. Focus on what matters for implementation. Not every omission is a gap — only flag things that would block or significantly affect development.
4. A conflict requires evidence from both sides. If only one document says something, it is not a conflict — it may be a gap or ambiguity.
5. Priority: conflicts are the most critical, then gaps, then ambiguities.`;

export const runChallenger = Effect.fn("agent/run-challenger")(function* (
  summaries: ReconstructedSummary[],
): Effect.fn.Return<GapReport, TextGenerationError> {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: summaries.map(prepareDocument).join("\n\n"),
    },
  ];

  const results = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model: anthropic("claude-haiku-4-5"),
        output: Output.object({ schema: GapReportSchema }),
        system: ChallengerSystemPrompt,
        messages,
      }),
    catch: (cause) => new TextGenerationError({ cause }),
  });

  return results.output;
});

function prepareDocument(doc: ReconstructedSummary): string {
  return [
    `=== ${doc.sourceDocument} ===\n${doc.summary}`,
    `Requirements:\n ${doc.requirements.map(prepareItem).join("\n")}`,
    `Constraints:\n ${doc.constraints.map(prepareItem).join("\n")}`,
    `Assumptions:\n ${doc.assumptions.map(prepareItem).join("\n")}`,
  ].join("\n\n");
}

function prepareItem(item: { confidence: string; text: string; sourceDocument: string }): string {
  return `- [${item.confidence}] ${item.text} (source: ${item.sourceDocument})`;
}
