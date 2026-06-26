import { defineConfig } from "oxlint";
export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  categories: { correctness: "error" },
  ignorePatterns: ["dist/**"],
  rules: {},
  env: {
    builtin: true,
    node: true,
  },
});
