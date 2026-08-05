import { Array, Effect, Filter, Option, pipe, Ref, Schema, Stream } from "effect";
import { Spans } from "../../observability/spans.ts";
import type { DocumentSummary } from "@shipwright/shared/domain/types";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { type MachineContext } from "@shipwright/shared/schemas/machine.js";
import { LanguageModel } from "effect/unstable/ai";
import { AnthropicClientLayer, AnthropicSonnetModelLayer } from "../providers.ts";
import { makeWriterToolkitLayer, WriterToolkit } from "../tools/writer-toolkit.ts";

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

TOOL USE: You have three tools available:
- query_chunks: semantic search over document chunks — use for targeted retrieval
- get_document: full text of a source document by filename — use when you need complete context
- get_document_summary: structured summary with requirements/constraints/assumptions — use to re-read the analysis for a specific document`;

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

    const finishRef = yield* Ref.make<{ modelId: string | undefined; inputTokens: number | undefined; outputTokens: number | undefined; cacheReadTokens: number | undefined } | undefined>(undefined);

    return yield* LanguageModel.streamText({
      toolkit: WriterToolkit,
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
      Effect.mapError((cause) => new BriefWriterError({ cause })),
    );
  },
  Effect.provide(AnthropicSonnetModelLayer),
  Effect.provide(AnthropicClientLayer),
);
