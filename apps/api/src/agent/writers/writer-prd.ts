import { Array, Effect, Filter, Option, pipe, Ref, Schema, Stream } from "effect";
import { Spans } from "../../observability/spans.ts";
import type { DocumentSummary } from "@shipwright/shared/domain/types";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { type MachineContext } from "@shipwright/shared/schemas/machine.js";
import { LanguageModel } from "effect/unstable/ai";
import { AnthropicClientLayer, AnthropicSonnetModelLayer } from "../providers.ts";
import { makeWriterToolkitLayer, WriterToolkit } from "../tools/writer-toolkit.ts";

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

TOOL USE: You have three tools available:
- query_chunks: semantic search over document chunks — use for targeted retrieval
- get_document: full text of a source document by filename — use when you need complete context
- get_document_summary: structured summary with requirements/constraints/assumptions — use to re-read the analysis for a specific document`;

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
        Option.map((answer) => `DECISION [${q.sourceDocuments.join(", ")}]: ${q.text}\nRESPONSE: ${answer.text}`),
      )
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
    const finishRef = yield* Ref.make<{ modelId: string | undefined; inputTokens: number | undefined; outputTokens: number | undefined; cacheReadTokens: number | undefined } | undefined>(undefined);

    return yield* LanguageModel.streamText({
      toolkit: WriterToolkit,
      prompt: [
        { role: "system", content: PrdSystemPrompt },
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
    }).pipe(
      Stream.provide(makeWriterToolkitLayer(sessionId)),
      Stream.tap((part) => {
        if (part.type === "finish") {
          return Ref.set(finishRef, {
            modelId: undefined,
            inputTokens: part.usage.inputTokens.total,
            outputTokens: part.usage.outputTokens.total,
            cacheReadTokens: part.usage.inputTokens.cacheRead,
          });
        }
        if (part.type === "response-metadata") {
          return Ref.update(finishRef, (prev) =>
            prev ? { ...prev, modelId: part.modelId } : { modelId: part.modelId, inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined },
          );
        }
        return Effect.void;
      }),
      Stream.filter((part) => part.type === "text-delta"),
      Stream.map((part) => part.delta),
      Stream.runFold(
        () => "",
        (acc, delta) => acc + delta,
      ),
      Effect.tap((text) =>
        Effect.annotateCurrentSpan({ "shipwright.output.chars": text.length }),
      ),
      Effect.tap(() =>
        Effect.flatMap(Ref.get(finishRef), (finish) =>
          finish
            ? Effect.annotateCurrentSpan(
                Spans.llm({
                  model: finish.modelId,
                  inputTokens: finish.inputTokens,
                  outputTokens: finish.outputTokens,
                  cacheReadTokens: finish.cacheReadTokens,
                }),
              )
            : Effect.void,
        ),
      ),
      Effect.mapError((cause) => new PrdWriterError({ cause })),
    );
  },
  Effect.provide(AnthropicSonnetModelLayer),
  Effect.provide(AnthropicClientLayer),
);
