import { getEncoding } from "js-tiktoken";
import { TokenCount } from "@shipwright/shared/domain/value-objects";

// Module-level singleton — getEncoding loads a WASM module and is expensive to call repeatedly.
const encoding = getEncoding("cl100k_base");

export function estimateTokenCount(text: string): TokenCount {
  return TokenCount.make(encoding.encode(text).length);
}
