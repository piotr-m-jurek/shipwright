import { Array, Effect, Filter, Layer, Option, pipe, Schema } from "effect";
import { Spans } from "../../observability/spans";
import type { DocumentSummary } from "@shipwright/shared/domain/types";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { type MachineContext } from "@shipwright/shared/schemas/machine";
import { Chat } from "effect/unstable/ai";
import { AnthropicClientLayer, AnthropicSonnetModelLayer } from "../providers";
import { runAgenticLoop } from "./agentic-loop";
import { LangfuseClient } from "../../observability/langfuse-client";
import { forkCompletenessJudge } from "./judge";

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

ANTI-HALLUCINATION RULE: Every requirement in the Acceptance Criteria must be traceable to the provided document summaries or clarification answers. Do not invent scope. If a section cannot be filled from the available information, say so explicitly.

OUTPUT RULE: Your response must contain ONLY the Implementation PRD document. Do not write any preamble, commentary, status updates, or thinking-aloud before, between, or after the sections. Start your response directly with "## Project Overview". Do not narrate what you are doing. The score-completeness tool calls happen silently — never include their results in the output text.

TOOL USE: You have four tools available:
- query_chunks: semantic search over document chunks — use for targeted retrieval
- get_document: full text of a source document by filename — use when you need complete context
- get_document_summary: structured summary with requirements/constraints/assumptions — use to re-read the analysis for a specific document
- score_completeness: evaluate a section you just wrote against the source context — call this after each major section. If score < 0.85, rewrite that section only (not the full document) before continuing.`;

function formatSummariesForPrd(
  summaries: DocumentSummary[],
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

  const answeredQuestions = Array.filterMap(
    questions,
    Filter.fromPredicateOption((q) =>
      pipe(
        Option.fromNullishOr(answers.find((a) => a.questionId === q.id)),
        Option.map(
          (answer) =>
            `DECISION [${q.sourceDocuments.join(", ")}]: ${q.text}\nRESPONSE: ${answer.text}`,
        ),
      ),
    ),
  ).join("\n\n");

  return [
    "=== DOCUMENT SUMMARIES ===",
    summarySection,
    answeredQuestions ? "\n=== RESOLVED DECISIONS ===" : "",
    answeredQuestions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const runPrdWriter = Effect.fn("agent/runPrdWriter")(
  function* (
    summaries: DocumentSummary[],
    answers: MachineContext["answers"],
    questions: MachineContext["questions"],
    sessionId: AgentSessionId,
  ) {
    yield* Effect.annotateCurrentSpan({
      ...Spans.pass("writer-prd"),
      ...Spans.counts({ documents: summaries.length, answers: answers.length }),
    });

    const userContent = formatSummariesForPrd(summaries, answers, questions);

    // Fetch prompt from Langfuse registry; fall back to hardcoded if unavailable.
    const langfuse = yield* LangfuseClient;
    const promptResult = yield* langfuse.getPrompt("shipwright-prd");
    const systemPrompt = Option.match(promptResult, {
      onNone: () => PrdSystemPrompt,
      onSome: (p) => p.text,
    });
    yield* Option.match(promptResult, {
      onNone: () => Effect.void,
      onSome: (p) =>
        Effect.annotateCurrentSpan({
          "langfuse.observation.prompt.name": p.name,
          "langfuse.observation.prompt.version": p.version,
        }),
    });

    const chat = yield* Chat.empty;

    const result = yield* runAgenticLoop({
      chat,
      firstTurnPrompt: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userContent,
              // Prompt caching: same document summaries as Brief pass — pays token cost once
              options: { anthropic: { cacheControl: { type: "ephemeral" } } },
            },
          ],
        },
      ],
      sessionId,
    }).pipe(Effect.mapError((cause) => new PrdWriterError({ cause })));

    yield* Effect.annotateCurrentSpan({ "shipwright.output.chars": result.text.length });
    yield* Effect.annotateCurrentSpan(
      Spans.llm({
        model: result.modelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
      }),
    );

    // Fire-and-forget completeness eval — did the PRD drop any requirement
    // from the source summaries or resolved Q&A? Never blocks the session pipeline.
    const span = yield* Effect.currentSpan;
    yield* forkCompletenessJudge({
      output: result.text,
      sourceContext: userContent,
      traceId: span.traceId,
    });

    return result.text;
  },
  Effect.provide(Layer.provideMerge(AnthropicClientLayer, AnthropicSonnetModelLayer)),
);
