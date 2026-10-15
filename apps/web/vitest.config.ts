import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
