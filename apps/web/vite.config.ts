import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": "http://localhost:3000" },
  },
  preview: {
    proxy: { "/api": "http://localhost:3000" },
  },
});
