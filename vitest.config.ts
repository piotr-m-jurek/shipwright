import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["docs/**", "node_modules/**"],
    env: {},
    setupFiles: ["./src/test-setup.ts"],
  },
});
