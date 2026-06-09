import { generateText, ModelMessage, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { DocumentAnalysis, GapReport, GapReportSchema } from "../shared/schemas/agent.js";

const ChallengerSystemPrompt = `You are an adversarial requirements reviewer. Your job is to find everything wrong, missing, or contradictory in a set of project documents and a preliminary requirements analysis.

You will receive:
1. The source documents (with filename headers)
2. An EXTRACTOR ANALYSIS section containing structured requirements already extracted

Your job is to find:
- CONFLICTS: Places where two documents directly contradict each other. Both documentA and documentB are required — name the exact filenames. Do not flag a conflict unless you can cite both sides.
- GAPS: Requirements that are missing entirely — things the system clearly needs but that no document specifies. Focus on gaps that would block development or cause rework.
- AMBIGUITIES: Requirements that are mentioned but underspecified — where a developer would need to make an assumption to implement them. Cite the source document.

RULES:
1. Be specific. Vague observations like "the PRD is incomplete" are not useful. Name the exact gap or contradiction.
2. For conflicts, you must name both files involved using their exact filenames.
3. Focus on what matters for implementation. Not every omission is a gap — only flag things that would block or significantly affect development.
4. Do not repeat things already captured well in the extractor analysis. Find what it missed.
5. Priority: conflicts are the most critical, then gaps, then ambiguities.`;

export async function runChallenger(
  documents: { filename: string; text: string }[],
  analysis: DocumentAnalysis,
): Promise<GapReport> {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        documents.map(prepareDocument).join("\n\n"),
        "=== EXTRACTOR ANALYSIS ===",
        JSON.stringify(analysis, null, 2),
      ].join("\n\n"),
    },
  ];

  const { output } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    output: Output.object({ schema: GapReportSchema }),
    system: ChallengerSystemPrompt,
    messages,
  });

  return output;
}

function prepareDocument(doc: { filename: string; text: string }): string {
  return `=== ${doc.filename} ===\n${doc.text}`;
}
