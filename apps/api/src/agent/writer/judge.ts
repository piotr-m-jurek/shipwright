/**
 * LLM-as-judge passes for Brief and PRD writer outputs.
 *
 * Brief  → faithfulness: did the Brief hallucinate anything not in the source summaries?
 * PRD    → completeness: did the PRD drop any requirement from the source summaries + Q&A?
 *
 * Both judges run fire-and-forget (Effect.fork) — they never block the session pipeline.
 * Scores are submitted to Langfuse via LangfuseClient.submitScore and appear on the
 * parent trace span in the Langfuse UI.
 *
 * Judge model: Haiku — fast and cheap, appropriate for automated eval passes.
 */

import { Effect, Layer } from "effect";
import { LanguageModel, Prompt } from "effect/unstable/ai";
import { FaithfulnessEvalSchema, CompletenessEvalSchema } from "@shipwright/shared/schemas/evals";
import { AnthropicClientLayer, AnthropicHaikuModelLayer } from "../providers";
import { LangfuseClient } from "../../observability/langfuse-client";

// ── Faithfulness judge (Brief) ─────────────────────────────────────────────

const FaithfulnessJudgeSystemPrompt = `You are an eval judge assessing whether a Project Brief faithfully represents its source documents.

A Brief is FAITHFUL if every requirement, constraint, decision, and claim it makes is traceable to the provided source summaries. It must not invent scope, assume decisions not recorded, or present uncertain items as resolved.

Score 0.0–1.0:
- 1.0: every claim is grounded in the source
- 0.7–0.9: minor paraphrasing drift, no invented scope
- 0.4–0.6: some claims not traceable to source
- 0.0–0.3: significant hallucinated requirements or decisions

Set pass=true if score >= 0.85.
Cite the specific hallucinated text in hallucinatedRequirements when score < 1.0.`;

const runFaithfulnessJudge = Effect.fn("agent/judge/faithfulness")(
  function* (opts: { output: string; sourceContext: string; traceId: string }) {
    const langfuse = yield* LangfuseClient;

    const result = yield* LanguageModel.generateObject({
      schema: FaithfulnessEvalSchema,
      prompt: Prompt.make([
        { role: "system", content: FaithfulnessJudgeSystemPrompt },
        {
          role: "user",
          content: `=== SOURCE SUMMARIES ===\n${opts.sourceContext}\n\n=== PROJECT BRIEF TO EVALUATE ===\n${opts.output}`,
        },
      ]),
    });

    yield* Effect.logInfo("[judge/faithfulness] score computed").pipe(
      Effect.annotateLogs({
        score: result.value.result.score,
        pass: result.value.result.pass,
        hallucinatedCount: result.value.hallucinatedRequirements.length,
      }),
    );

    yield* langfuse.submitScore({
      traceId: opts.traceId,
      name: "faithfulness",
      value: result.value.result.score,
      comment: result.value.result.reasoning,
    });
  },
  Effect.provide(Layer.provideMerge(AnthropicHaikuModelLayer, AnthropicClientLayer)),
);

// ── Completeness judge (PRD) ───────────────────────────────────────────────

const CompletenessJudgeSystemPrompt = `You are an eval judge assessing whether an Implementation PRD is complete relative to its source documents and resolved clarifications.

A PRD is COMPLETE if every requirement, constraint, assumption, and resolved decision from the source summaries appears in the PRD's Acceptance Criteria, Technical Requirements, or relevant section. Items may be merged or rephrased but must not be silently dropped.

Score 0.0–1.0:
- 1.0: no items dropped
- 0.7–0.9: minor items omitted that are low-impact
- 0.4–0.6: several requirements missing
- 0.0–0.3: significant scope dropped

Set pass=true if score >= 0.85.
List every dropped item in droppedItems with its source document when score < 1.0.`;

const runCompletenessJudge = Effect.fn("agent/judge/completeness")(
  function* (opts: { output: string; sourceContext: string; traceId: string }) {
    const langfuse = yield* LangfuseClient;

    const result = yield* LanguageModel.generateObject({
      schema: CompletenessEvalSchema,
      prompt: Prompt.make([
        { role: "system", content: CompletenessJudgeSystemPrompt },
        {
          role: "user",
          content: `=== SOURCE SUMMARIES AND RESOLVED DECISIONS ===\n${opts.sourceContext}\n\n=== IMPLEMENTATION PRD TO EVALUATE ===\n${opts.output}`,
        },
      ]),
    });

    yield* Effect.logInfo("[judge/completeness] score computed").pipe(
      Effect.annotateLogs({
        score: result.value.result.score,
        pass: result.value.result.pass,
        droppedCount: result.value.droppedItems.length,
      }),
    );

    yield* langfuse.submitScore({
      traceId: opts.traceId,
      name: "completeness",
      value: result.value.result.score,
      comment: result.value.result.reasoning,
    });
  },
  Effect.provide(Layer.provideMerge(AnthropicHaikuModelLayer, AnthropicClientLayer)),
);

// ── Public fire-and-forget wrappers ────────────────────────────────────────

/**
 * Fork a faithfulness eval for a Brief output. Never blocks the caller.
 * Errors are logged and swallowed — judge failures must not affect the session.
 */
export const forkFaithfulnessJudge = (opts: {
  output: string;
  sourceContext: string;
  traceId: string;
}) =>
  runFaithfulnessJudge(opts).pipe(
    Effect.tapCause((cause) => Effect.logError("[judge/faithfulness] failed", cause)),
    Effect.ignore,
    Effect.forkDetach,
    Effect.asVoid,
  );

/**
 * Fork a completeness eval for a PRD output. Never blocks the caller.
 * Errors are logged and swallowed — judge failures must not affect the session.
 */
export const forkCompletenessJudge = (opts: {
  output: string;
  sourceContext: string;
  traceId: string;
}) =>
  runCompletenessJudge(opts).pipe(
    Effect.tapCause((cause) => Effect.logError("[judge/completeness] failed", cause)),
    Effect.ignore,
    Effect.forkDetach,
    Effect.asVoid,
  );
