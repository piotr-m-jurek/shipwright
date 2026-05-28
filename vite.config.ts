import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import devServer from "@hono/vite-dev-server";

export default defineConfig({
  root: "src/web",
  plugins: [react(), devServer({ entry: "src/index.ts" })],
});
