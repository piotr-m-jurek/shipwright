
import { getEncoding } from "js-tiktoken";

export function estimateTokenCount(text: string): number {
  const encoding = getEncoding("cl100k_base");
  return encoding.encode(text).length;
}
