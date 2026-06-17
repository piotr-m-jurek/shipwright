import { getEncoding } from "js-tiktoken";

// Module-level singleton — getEncoding loads a WASM module and is expensive to call repeatedly.
const encoding = getEncoding("cl100k_base");

export function estimateTokenCount(text: string): number {
  return encoding.encode(text).length;
}
