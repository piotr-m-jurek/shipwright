/**
 * Agentic writer loop.
 *
 * The model calls tools before writing text (e.g. score-completeness,
 * get-document-summary). Chat.streamText is single-turn: one request,
 * tool calls resolved, stream ends. The model's finish reason tells us
 * whether it wants to continue ("tool-calls") or is done ("stop").
 *
 * After each turn, Chat has appended the response + tool results to its
 * internal history. Calling chat.streamText again with an empty prompt
 * lets the model see those results and continue generating.
 *
 * Why not full-draft revision on score < threshold:
 *   Re-generating the full draft re-spends all input tokens (summaries + Q&A).
 *   Section-level revision from the score-completeness tool targets only the
 *   deficient section at a fraction of the cost — the model handles this
 *   internally via tool use within the same loop.
 *
 * Max iterations: 10 (guards against runaway tool-call loops).
 */

import { Effect, Ref, Stream } from "effect";
import type { Chat } from "effect/unstable/ai";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { makeWriterToolkitLayer, WriterToolkit } from "./tools/writer-toolkit.ts";
import type { Prompt } from "effect/unstable/ai";

const MAX_ITERATIONS = 10;

export interface LoopResult {
  text: string;
  modelId: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
}

export const runAgenticLoop = (opts: {
  chat: Chat.Service;
  firstTurnPrompt: Prompt.RawInput;
  sessionId: AgentSessionId;
}) =>
  Effect.gen(function* () {
    const { chat, firstTurnPrompt, sessionId } = opts;
    const textAcc = yield* Ref.make("");
    const finishRef = yield* Ref.make<{
      reason: string;
      modelId: string | undefined;
      inputTokens: number | undefined;
      outputTokens: number | undefined;
      cacheReadTokens: number | undefined;
    } | undefined>(undefined);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // First turn: send the real prompt (system + user content).
      // Subsequent turns: empty prompt — Chat history already contains the
      // assistant response + tool results from the prior turn, so the model
      // can continue without a new user message.
      const turnPrompt: Prompt.RawInput = i === 0 ? firstTurnPrompt : [];

      yield* chat.streamText({
        toolkit: WriterToolkit,
        prompt: turnPrompt,
      }).pipe(
        Stream.provide(makeWriterToolkitLayer(sessionId)),
        Stream.tap((part) => {
          if (part.type === "text-delta") {
            return Ref.update(textAcc, (acc) => acc + part.delta);
          }
          if (part.type === "finish") {
            return Ref.update(finishRef, (prev) => ({
              reason: part.reason,
              modelId: prev?.modelId,
              inputTokens: part.usage.inputTokens.total,
              outputTokens: part.usage.outputTokens.total,
              cacheReadTokens: part.usage.inputTokens.cacheRead,
            }));
          }
          if (part.type === "response-metadata") {
            return Ref.update(finishRef, (prev) =>
              prev
                ? { ...prev, modelId: part.modelId }
                : { reason: "unknown", modelId: part.modelId, inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined },
            );
          }
          return Effect.void;
        }),
        Stream.runDrain,
      );

      const finish = yield* Ref.get(finishRef);

      // "stop" (or anything other than "tool-calls") means the model is done.
      if (!finish || finish.reason !== "tool-calls") {
        break;
      }

      yield* Effect.logInfo(`[agenticLoop] turn ${i + 1} finished with tool-calls, continuing`);
    }

    const rawText = yield* Ref.get(textAcc);
    const finish = yield* Ref.get(finishRef);

    // Strip any model preamble / commentary before the first markdown heading.
    // The system prompt instructs the model to start directly with a heading,
    // but this is a safety net in case it narrates tool usage before writing.
    // Match "##" at start of string or after a newline.
    const headingMatch = rawText.match(/(^|\n)(##\s)/);
    const text = headingMatch?.index != null && headingMatch.index > 0
      ? rawText.slice(headingMatch.index + (headingMatch[1] === "\n" ? 1 : 0))
      : rawText;

    return {
      text,
      modelId: finish?.modelId,
      inputTokens: finish?.inputTokens,
      outputTokens: finish?.outputTokens,
      cacheReadTokens: finish?.cacheReadTokens,
    };
  });
