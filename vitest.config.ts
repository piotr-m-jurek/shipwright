import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {}, // env vars loaded via .env file below
    setupFiles: ["./src/test-setup.ts"],
  },
});
