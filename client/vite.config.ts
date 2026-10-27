import { defineConfig } from "vitest/config";

export default defineConfig({
  server: { port: 5173, fs: { allow: [".."] } },
  test: { environment: "node", testTimeout: 120_000, hookTimeout: 120_000, include: ["src/**/*.test.ts"] },
});
