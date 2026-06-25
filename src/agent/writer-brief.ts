import { Effect, Schema, Stream } from "effect";
import type { ReconstructedSummary } from "../db/queries.js";
import { MachineContext } from "../shared/schemas/machine.js";
import { LanguageModel, Response } from "effect/unstable/ai";
import { AnthropicLanguageModel } from "@effect/ai-anthropic";
import "@effect/ai-anthropic/AnthropicLanguageModel";
import { AnthropicClientLayer } from "./providers.js";

export class BriefWriterError extends Schema.TaggedErrorClass<BriefWriterError>()(
  "shipwright/agent/BriefWriterError",
  {
    cause: Schema.Defect(),
  },
) {}

const BriefSystemPrompt = `You are a technical writer producing a Project Brief for a non-technical stakeholder.

The Project Brief must:
- Be readable in under 5 minutes
- Use plain language — no jargon, no technical implementation details
- Tell a clear story: what the project is, why it exists, what it will do, what is explicitly out of scope
- Cite specific source documents where key decisions are grounded (e.g. "per the RFP" or "as agreed in the discovery call")
- Include a short summary of open questions that were resolved during the clarifying session

Structure (use these Markdown headings):
## Overview
## What Will Be Built
## What Is Out of Scope
## Key Constraints
## Resolved Decisions
## Next Steps

ANTI-HALLUCINATION RULE: Do not include any requirement, constraint, or decision not present in the provided summaries or answers. If something is unclear, say it is unclear — do not invent clarity.`;

function formatSummariesForBrief(
  summaries: ReconstructedSummary[],
  answers: MachineContext["answers"],
  questions: MachineContext["questions"],
): string {
  const summarySection = summaries
    .map((s) => {
      const items = [
        ...s.requirements.map((r) => `  - [req] ${r.text} (${r.confidence})`),
        ...s.constraints.map((c) => `  - [constraint] ${c.text} (${c.confidence})`),
        ...s.assumptions.map((a) => `  - [assumption] ${a.text} (${a.confidence})`),
      ].join("\n");
      return `=== ${s.sourceDocument} ===\n${s.summary}${items ? `\n${items}` : ""}`;
    })
    .join("\n\n");

  const answeredQuestions = questions
    .map((q) => {
      const answer = answers.find((a) => a.questionId === q.id);
      return answer ? `Q: ${q.text}\nA: ${answer.text}` : null;
    })
    .filter(Boolean)
    .join("\n\n");

  return [
    "=== DOCUMENT SUMMARIES ===",
    summarySection,
    answeredQuestions ? "\n=== RESOLVED CLARIFICATIONS ===" : "",
    answeredQuestions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const sonnetModel = AnthropicLanguageModel.model("claude-sonnet-4-6");

/**
 * Run the Brief writer pass. Returns the full text after streaming completes.
 * Uses prompt caching on the document summaries (static across both writer passes).
 */
export const runBriefWriter = Effect.fn("agent/runBriefWriter")(function* (
  summaries: ReconstructedSummary[],
  answers: MachineContext["answers"],
  questions: MachineContext["questions"],
) {
  const userContent = formatSummariesForBrief(summaries, answers, questions);

  return yield* LanguageModel.streamText({
    prompt: [
      { role: "system", content: BriefSystemPrompt },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: userContent,
            // Prompt caching: document summaries are identical across Brief and PRD passes
            options: { anthropic: { cacheControl: { type: "ephemeral" } } },
          },
        ],
      },
    ],
  }  ).pipe(
    Stream.filter((part): part is Response.TextDeltaPart => part.type === "text-delta"),
    Stream.map((part) => part.delta),
    Stream.runFold(() => "", (acc, delta) => acc + delta),
    Effect.mapError((cause) => new BriefWriterError({ cause })),
  );
}, Effect.provide(sonnetModel), Effect.provide(AnthropicClientLayer));
