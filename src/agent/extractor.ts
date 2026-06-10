import { generateText, ModelMessage, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { DocumentAnalysisSchema } from "../shared/schemas/agent.js";
import { Effect } from "effect";

const ExtractorSystemPrompt = `You are an expert requirements analyst. Your job is to extract every requirement, constraint, and assumption from a set of project documents.

RULES — follow these without exception:
1. Every item you return MUST include sourceDocument — the exact filename it came from. Never omit this.
2. Extract only what is explicitly stated or clearly implied by the source material. Do not invent requirements.
3. If the same requirement appears in multiple documents, include it once and cite the most authoritative source.
4. Requirements are things the system must do or support.
5. Constraints are limitations or non-negotiable conditions (timeline, compliance, performance, out-of-scope items).
6. Assumptions are things taken for granted that are not explicitly confirmed but implied by the documents.
7. Confidence levels: high = explicitly stated, medium = clearly implied, low = inferred from context.

The documents will be provided with filename headers in the format:
=== filename ===
content

Use the exact filename (including extension) as the sourceDocument value.`;

type Document = {
  filename: string;
  text: string;
};

export const runExtractor = Effect.fn("agent/runExtractor")(function* (documents: Document[]) {
  const message: ModelMessage = {
    role: "user",
    content: documents.map(prepareDocument).join("\n\n"),
  };

  const { output } = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model: anthropic("claude-sonnet-4-6"),
        output: Output.object({ schema: DocumentAnalysisSchema }),
        system: ExtractorSystemPrompt,
        messages: [message],
      }),
    catch: (cause) => new TextGenerationError({ cause }),
  });

  return output;
});

function prepareDocument(doc: Document) {
  return `=== ${doc.filename} ===\n${doc.text}`;
}
