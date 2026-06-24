import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Effect, Schema } from "effect";
import type { ReconstructedSummary } from "../db/queries.js";
import { MachineContext } from "../shared/schemas/machine.js";

export class PrdWriterError extends Schema.TaggedErrorClass<PrdWriterError>()(
  "shipwright/agent/PrdWriterError",
  {
    cause: Schema.Defect(),
  },
) {}

// This prompt is a meta-prompting exercise: the PRD is written FOR a coding agent,
// not for a human. Structure, specificity, and completeness matter more than readability.
const PrdSystemPrompt = `You are writing an Implementation PRD that will be given directly to a coding agent (Claude Code, Cursor, or Codex) as its primary instruction set. The coding agent will read this document and start implementing without further clarification.

This is NOT a human-readable document. Write for a coding agent.

The PRD must contain the following sections — use these exact Markdown headings:

## Project Overview
One paragraph. What is being built and why. Include the tech stack if known.

## Acceptance Criteria
Numbered list. Each item must be testable and specific. Format: "[ ] <criterion>"
Cover: happy path, edge cases, error states, and integration points.

## Non-Goals
Explicit list of what is OUT OF SCOPE for this implementation. Be specific.
The coding agent must not implement anything on this list.

## Technical Requirements
- Data models / schema changes required
- API endpoints with method, path, request shape, response shape, and error codes
- Third-party integrations and their specific API calls
- Performance requirements (response times, concurrency limits)

## File and Module Hints
Suggested file structure and module boundaries. Not prescriptive — the coding agent can deviate with good reason.

## Edge Cases and Error Handling
Specific scenarios that must be handled. Each with: scenario, expected behaviour, error response if applicable.

## Recommended Stack
Technology choices already decided. The coding agent should use these unless there is a strong technical reason not to.

## Open Questions
Any ambiguities that remain after the clarifying session. The coding agent must surface these before implementing the affected feature, not make silent assumptions.

ANTI-HALLUCINATION RULE: Every requirement in the Acceptance Criteria must be traceable to the provided document summaries or clarification answers. Do not invent scope. If a section cannot be filled from the available information, say so explicitly.`;

function formatSummariesForPrd(
  summaries: ReconstructedSummary[],
  answers: MachineContext["answers"],
  questions: MachineContext["questions"],
): string {
  const summarySection = summaries
    .map((s) => {
      const reqs = s.requirements.map((r) => `  REQ [${r.confidence}]: ${r.text}`).join("\n");
      const cons = s.constraints.map((c) => `  CONSTRAINT [${c.confidence}]: ${c.text}`).join("\n");
      const asms = s.assumptions.map((a) => `  ASSUMPTION [${a.confidence}]: ${a.text}`).join("\n");
      const items = [reqs, cons, asms].filter(Boolean).join("\n");
      return `=== ${s.sourceDocument} (${s.sourceDocument.split(".").pop()?.toUpperCase()}) ===\n${s.summary}${items ? `\n${items}` : ""}`;
    })
    .join("\n\n");

  const answeredQuestions = questions
    .map((q) => {
      const answer = answers.find((a) => a.questionId === q.id);
      return answer
        ? `DECISION [${q.sourceDocuments.join(", ")}]: ${q.text}\nRESPONSE: ${answer.text}`
        : null;
    })
    .filter(Boolean)
    .join("\n\n");

  return [
    "=== DOCUMENT SUMMARIES ===",
    summarySection,
    answeredQuestions ? "\n=== RESOLVED DECISIONS ===" : "",
    answeredQuestions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Run the PRD writer pass. Returns the full text after streaming completes.
 * Uses prompt caching on the document summaries (shared with Brief writer pass).
 */
export const runPrdWriter = Effect.fn("agent/runPrdWriter")(function* (
  summaries: ReconstructedSummary[],
  answers: MachineContext["answers"],
  questions: MachineContext["questions"],
) {
  const userContent = formatSummariesForPrd(summaries, answers, questions);

  const result = yield* Effect.tryPromise({
    try: async () => {
      const stream = streamText({
        model: anthropic("claude-sonnet-4-6"),
        system: PrdSystemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: userContent,
                // Prompt caching: same document summaries as Brief pass — pays token cost once
                providerOptions: {
                  anthropic: { cacheControl: { type: "ephemeral" } },
                },
              },
            ],
          },
        ],
      });
      return await stream.text;
    },
    catch: (cause) => new PrdWriterError({ cause }),
  });

  return result;
});
