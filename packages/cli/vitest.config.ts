import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { NO_COLOR: "1" },
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/test-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
