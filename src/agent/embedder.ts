import { embedMany } from "ai";
import { openai } from "@ai-sdk/openai";

export async function embedChunks(chunks: string[]): Promise<number[][]> {
  // TODO: embedMany has a default batch limit

  const { embeddings } = await embedMany({
    model: openai.embedding("text-embedding-3-small"),
    values: chunks,
  });
  return embeddings;
}
