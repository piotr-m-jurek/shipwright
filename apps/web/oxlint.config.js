import { defineConfig } from "oxlint";
export default defineConfig({
  plugins: ["typescript", "react", "unicorn", "oxc"],
  categories: { correctness: "error" },
  ignorePatterns: ["dist/**"],
  rules: {
    "react/self-closing-comp": "error",
  },
  env: {
    builtin: true,
    browser: true,
  },
});
