import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
const main = Effect.gen(function* () {
  yield* Effect.log("Hello from MCP");
});
BunRuntime.runMain(main);
