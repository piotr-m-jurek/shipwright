import { Effect, Schema, Stream } from "effect";
import type { ReconstructedSummary } from "../db/queries.js";
import { LanguageModel, Response } from "effect/unstable/ai";
import { AnthropicLanguageModel } from "@effect/ai-anthropic";
import "@effect/ai-anthropic/AnthropicLanguageModel";
import { AnthropicClientLayer } from "./providers.js";

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
5. Maintain the same Markdown section structure as the original`;

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
5. Update acceptance criteria to reflect any changed scope`;

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

/**
 * Run the revision Brief writer. Incorporates user feedback into existing Brief.
 */
export const runRevisionBriefWriter = Effect.fn("agent/runRevisionBriefWriter")(function* (
  summaries: ReconstructedSummary[],
  existingBrief: string,
  existingPrd: string,
  feedback: string,
) {
  const userContent = formatRevisionInput(summaries, existingBrief, existingPrd, feedback);

  return yield* LanguageModel.streamText({
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
  }  ).pipe(
    Stream.filter((part): part is Response.TextDeltaPart => part.type === "text-delta"),
    Stream.map((part) => part.delta),
    Stream.runFold(() => "", (acc, delta) => acc + delta),
    Effect.mapError((cause) => new RevisionWriterError({ cause })),
  );
}, Effect.provide(sonnetModel), Effect.provide(AnthropicClientLayer));

/**
 * Run the revision PRD writer. Incorporates user feedback into existing PRD.
 */
export const runRevisionPrdWriter = Effect.fn("agent/runRevisionPrdWriter")(function* (
  summaries: ReconstructedSummary[],
  existingBrief: string,
  existingPrd: string,
  feedback: string,
) {
  const userContent = formatRevisionInput(summaries, existingBrief, existingPrd, feedback);

  return yield* LanguageModel.streamText({
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
  }  ).pipe(
    Stream.filter((part): part is Response.TextDeltaPart => part.type === "text-delta"),
    Stream.map((part) => part.delta),
    Stream.runFold(() => "", (acc, delta) => acc + delta),
    Effect.mapError((cause) => new RevisionWriterError({ cause })),
  );
}, Effect.provide(sonnetModel), Effect.provide(AnthropicClientLayer));

