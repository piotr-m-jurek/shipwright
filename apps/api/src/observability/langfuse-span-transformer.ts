/**
 * Langfuse span transformer for LLM generation spans.
 *
 * Effect's @effect/ai-anthropic emits gen_ai.* OTel attributes for usage and
 * model, but does NOT set prompt/completion content on spans. Langfuse needs
 * langfuse.observation.input and langfuse.observation.output to show input/output
 * in the UI.
 *
 * The SpanTransformer hook fires at the end of every LanguageModel.streamText /
 * generateObject call with the full prompt and response. We extract the text
 * and set the Langfuse attributes directly on the span.
 */

import { Layer } from "effect";
import { Response, Telemetry } from "effect/unstable/ai";

// Max chars to store per observation — avoids bloating traces with huge prompts.
const MAX_INPUT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 4_000;

const transformer: Telemetry.SpanTransformer = ({ prompt, response, span }) => {
  // ── Input: extract system + user messages from the prompt ────────────────
  const inputMessages = prompt.content.map((msg) => {
    const role = msg.role;
    let content: string;
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = (msg.content as Array<unknown>)
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part === "object" && part !== null && "type" in part) {
            const p = part as Record<string, unknown>;
            if (p.type === "text" && typeof p.text === "string") return p.text;
            return `[${p.type}]`;
          }
          return "";
        })
        .join(" ");
    } else {
      content = String(msg.content);
    }
    return { role, content };
  });

  const inputJson = JSON.stringify(inputMessages);
  span.attribute(
    "langfuse.observation.input",
    inputJson.length > MAX_INPUT_CHARS
      ? inputJson.slice(0, MAX_INPUT_CHARS) + "…"
      : inputJson,
  );

  // ── Output: concatenate all text parts from the response ─────────────────
  const outputText = response
    .filter((part): part is Response.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");

  if (outputText.length > 0) {
    span.attribute(
      "langfuse.observation.output",
      outputText.length > MAX_OUTPUT_CHARS
        ? outputText.slice(0, MAX_OUTPUT_CHARS) + "…"
        : outputText,
    );
  }
};

/**
 * Provides the Langfuse span transformer to all LLM calls in scope.
 * Add to any layer that runs LanguageModel.streamText or generateObject.
 */
export const LangfuseSpanTransformerLayer = Layer.succeed(
  Telemetry.CurrentSpanTransformer,
  transformer,
);
