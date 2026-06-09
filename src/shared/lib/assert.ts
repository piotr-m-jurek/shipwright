export function assert(condition: boolean, message?: string): asserts condition {
  if (!condition) {
    throw new Error("Assertion failed", { cause: message });
  }
}
