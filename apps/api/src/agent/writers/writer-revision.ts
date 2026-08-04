import { Effect, Schema, Stream } from "effect";
import type { ReconstructedSummary } from "../../db/services/summary.ts";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { Spans } from "../../observability/spans.ts";
import { LanguageModel } from "effect/unstable/ai";
import { AnthropicLanguageModel } from "@effect/ai-anthropic";
import "@effect/ai-anthropic/AnthropicLanguageModel";
import { AnthropicClientLayer } from "../providers.ts";
import { makeQueryChunksLayer, QueryChunksToolkit } from "../tools/query-chunks.ts";

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

TOOL USE: You have access to a query_chunks tool. If the feedback references a specific area (e.g. "the auth section needs more detail"), call query_chunks with a targeted query before revising that section. Use it to verify claims against source material before adding them.`;

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

TOOL USE: You have access to a query_chunks tool. If the feedback references a specific area (e.g. "the auth section needs more detail"), call query_chunks with a targeted query before revising that section. Use it to verify claims against source material before adding them.`;

function formatRevisionInput(
  summaries: ReconstructedSummary[],
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

const sonnetModel = AnthropicLanguageModel.model("claude-sonnet-4-6");

export const runRevisionBriefWriter = Effect.fn("agent/runRevisionBriefWriter")(
  function* (
    summaries: ReconstructedSummary[],
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

    return yield* LanguageModel.streamText({
      toolkit: QueryChunksToolkit,
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
      Stream.provide(makeQueryChunksLayer(sessionId)),
      Stream.filter((part) => part.type === "text-delta"),
      Stream.map((part) => part.delta),
      Stream.runFold(
        () => "",
        (acc, delta) => acc + delta,
      ),
      Effect.mapError((cause) => new RevisionWriterError({ cause })),
    );
  },
  Effect.provide(sonnetModel),
  Effect.provide(AnthropicClientLayer),
);

export const runRevisionPrdWriter = Effect.fn("agent/runRevisionPrdWriter")(
  function* (
    summaries: ReconstructedSummary[],
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

    return yield* LanguageModel.streamText({
      toolkit: QueryChunksToolkit,
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
      Stream.provide(makeQueryChunksLayer(sessionId)),
      Stream.filter((part) => part.type === "text-delta"),
      Stream.map((part) => part.delta),
      Stream.runFold(
        () => "",
        (acc, delta) => acc + delta,
      ),
      Effect.mapError((cause) => new RevisionWriterError({ cause })),
    );
  },
  Effect.provide(sonnetModel),
  Effect.provide(AnthropicClientLayer),
);
