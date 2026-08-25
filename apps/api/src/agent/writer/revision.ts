import { Effect, Ref, Schema, Stream } from "effect";
import type { DocumentSummary } from "@shipwright/shared/domain/types";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { Spans } from "@shipwright/observability";

type LlmFinishCapture = {
  modelId: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
};
import { LanguageModel } from "effect/unstable/ai";
import { AnthropicClientLayer, AnthropicSonnetModelLayer } from "../providers";
import { makeWriterToolkitLayer, WriterToolkit } from "./tools/writer-toolkit";
import { forkFaithfulnessJudge, forkCompletenessJudge } from "./judge";

export class RevisionWriterError extends Schema.TaggedErrorClass<RevisionWriterError>()(
  "shipwright/agent/RevisionWriterError",
  { cause: Schema.Defect() },
) {}

const RevisionBriefSystemPrompt = `You are revising an existing Project Brief based on user feedback.

You will receive:
1. The original Project Brief
2. The original Implementation PRD
3. The document summaries that produced them
4. Free-form feedback from the user describing what to change

Your task is to produce a revised Project Brief that incorporates the feedback.

RULES:
1. Keep everything that the user did not ask to change
2. Make only the changes requested in the feedback
3. Do not introduce new requirements not present in the summaries or feedback
4. Cite sources for any new claims you add
5. Maintain the same Markdown section structure as the original

TOOL USE: You have three tools available:
- query_chunks: semantic search over document chunks
- get_document: full text of a source document by filename
- get_document_summary: structured summary for a specific document`;

const RevisionPrdSystemPrompt = `You are revising an existing Implementation PRD based on user feedback.

You will receive:
1. The original Project Brief
2. The original Implementation PRD
3. The document summaries that produced them
4. Free-form feedback from the user describing what to change

Your task is to produce a revised Implementation PRD that incorporates the feedback.

RULES:
1. Keep everything that the user did not ask to change
2. Make only the changes requested in the feedback
3. Do not invent scope — only add requirements traceable to summaries or feedback
4. Maintain the same Markdown section structure as the original
5. Update acceptance criteria to reflect any changed scope

TOOL USE: You have three tools available:
- query_chunks: semantic search over document chunks
- get_document: full text of a source document by filename
- get_document_summary: structured summary for a specific document`;

function formatRevisionInput(
  summaries: DocumentSummary[],
  existingBrief: string,
  existingPrd: string,
  feedback: string,
): string {
  const summarySection = summaries
    .map((s) => `=== ${s.sourceDocument} ===\n${s.summary}`)
    .join("\n\n");

  return [
    "=== ORIGINAL PROJECT BRIEF ===",
    existingBrief,
    "",
    "=== ORIGINAL IMPLEMENTATION PRD ===",
    existingPrd,
    "",
    "=== DOCUMENT SUMMARIES ===",
    summarySection,
    "",
    "=== USER FEEDBACK ===",
    feedback,
  ].join("\n\n");
}

export const runRevisionBriefWriter = Effect.fn("agent/runRevisionBriefWriter")(
  function* (
    summaries: DocumentSummary[],
    existingBrief: string,
    existingPrd: string,
    feedback: string,
    sessionId: AgentSessionId,
  ) {
    yield* Effect.annotateCurrentSpan({
      ...Spans.pass("writer-revision-brief"),
      ...Spans.counts({ documents: summaries.length, feedbackLength: feedback.length }),
    });
    const userContent = formatRevisionInput(summaries, existingBrief, existingPrd, feedback);
    const finishRef = yield* Ref.make<LlmFinishCapture | undefined>(undefined);

    return yield* LanguageModel.streamText({
      toolkit: WriterToolkit,
      prompt: [
        { role: "system", content: RevisionBriefSystemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userContent,
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
        Effect.annotateCurrentSpan(Spans.output({ chars: text.length })),
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
      // Fire-and-forget faithfulness eval — same as the initial Brief generation
      // pass (brief.ts) — does the revised Brief hallucinate anything not in the
      // source summaries/original documents/feedback? Never blocks the pipeline.
      Effect.tap((text) =>
        Effect.flatMap(Effect.currentSpan, (span) =>
          forkFaithfulnessJudge({
            output: text,
            sourceContext: userContent,
            traceId: span.traceId,
          }),
        ),
      ),
      Effect.mapError((cause) => new RevisionWriterError({ cause })),
    );
  },
  Effect.provide(AnthropicSonnetModelLayer),
  Effect.provide(AnthropicClientLayer),
);

export const runRevisionPrdWriter = Effect.fn("agent/runRevisionPrdWriter")(
  function* (
    summaries: DocumentSummary[],
    existingBrief: string,
    existingPrd: string,
    feedback: string,
    sessionId: AgentSessionId,
  ) {
    yield* Effect.annotateCurrentSpan({
      ...Spans.pass("writer-revision-prd"),
      ...Spans.counts({ documents: summaries.length, feedbackLength: feedback.length }),
    });
    const userContent = formatRevisionInput(summaries, existingBrief, existingPrd, feedback);
    const finishRef = yield* Ref.make<LlmFinishCapture | undefined>(undefined);

    return yield* LanguageModel.streamText({
      toolkit: WriterToolkit,
      prompt: [
        { role: "system", content: RevisionPrdSystemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userContent,
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
        Effect.annotateCurrentSpan(Spans.output({ chars: text.length })),
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
      // Fire-and-forget completeness eval — same as the initial PRD generation
      // pass (prd.ts) — did the revised PRD drop any requirement from the
      // source summaries/original documents/feedback? Never blocks the pipeline.
      Effect.tap((text) =>
        Effect.flatMap(Effect.currentSpan, (span) =>
          forkCompletenessJudge({
            output: text,
            sourceContext: userContent,
            traceId: span.traceId,
          }),
        ),
      ),
      Effect.mapError((cause) => new RevisionWriterError({ cause })),
    );
  },
  Effect.provide(AnthropicSonnetModelLayer),
  Effect.provide(AnthropicClientLayer),
);
