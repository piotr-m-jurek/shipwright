import { config } from "dotenv";
import path from "node:path";

// // Load .env before any module that calls process.loadEnvFile() or envOrThrow()
// config({ path: path.resolve(process.cwd(), ".env"), override: true });
//
// // Polyfill process.loadEnvFile for Node/Vitest environments (it's Bun-only)
// if (!("loadEnvFile" in process)) {
//   (process as NodeJS.Process & { loadEnvFile: () => void }).loadEnvFile = () => {
//     // already loaded by dotenv above
//   };
// }
