import { Array, Effect, Filter, Option, pipe, Schema } from "effect";
import { Spans } from "../../observability/spans.ts";
import type { DocumentSummary } from "@shipwright/shared/domain/types";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { type MachineContext } from "@shipwright/shared/schemas/machine.js";
import { Chat } from "effect/unstable/ai";
import { AnthropicClientLayer, AnthropicSonnetModelLayer } from "../providers.ts";
import { runAgenticLoop } from "./agentic-loop.ts";

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

ANTI-HALLUCINATION RULE: Do not include any requirement, constraint, or decision not present in the provided summaries or answers. If something is unclear, say it is unclear — do not invent clarity.

OUTPUT RULE: Your response must contain ONLY the Project Brief document. Do not write any preamble, commentary, status updates, or thinking-aloud before, between, or after the sections. Start your response directly with "## Overview". Do not narrate what you are doing. The score-completeness tool calls happen silently — never include their results in the output text.

TOOL USE: You have four tools available:
- query_chunks: semantic search over document chunks — use for targeted retrieval
- get_document: full text of a source document by filename — use when you need complete context
- get_document_summary: structured summary with requirements/constraints/assumptions — use to re-read the analysis for a specific document
- score_completeness: evaluate a section you just wrote against the source context — call this after each major section. If score < 0.85, rewrite that section only (not the full document) before continuing.`;

function formatSummariesForBrief(
  summaries: DocumentSummary[],
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

  const answeredQuestions = Array.filterMap(
    questions,
    Filter.fromPredicateOption((q) =>
      pipe(
        Option.fromNullishOr(answers.find((a) => a.questionId === q.id)),
        Option.map((answer) => `Q: ${q.text}\nA: ${answer.text}`),
      )
    ),
  ).join("\n\n");

  return [
    "=== DOCUMENT SUMMARIES ===",
    summarySection,
    answeredQuestions ? "\n=== RESOLVED CLARIFICATIONS ===" : "",
    answeredQuestions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const runBriefWriter = Effect.fn("agent/runBriefWriter")(
  function* (
    summaries: DocumentSummary[],
    answers: MachineContext["answers"],
    questions: MachineContext["questions"],
    sessionId: AgentSessionId,
  ) {
    yield* Effect.annotateCurrentSpan({
      ...Spans.pass("writer-brief"),
      ...Spans.counts({ documents: summaries.length, answers: answers.length }),
    });

    const userContent = formatSummariesForBrief(summaries, answers, questions);

    const chat = yield* Chat.empty;

    const result = yield* runAgenticLoop({
      chat,
      firstTurnPrompt: [
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
      sessionId,
    }).pipe(Effect.mapError((cause) => new BriefWriterError({ cause })));

    yield* Effect.annotateCurrentSpan({ "shipwright.output.chars": result.text.length });
    yield* Effect.annotateCurrentSpan(
      Spans.llm({
        model: result.modelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
      }),
    );

    return result.text;
  },
  Effect.provide(AnthropicSonnetModelLayer),
  Effect.provide(AnthropicClientLayer),
);
