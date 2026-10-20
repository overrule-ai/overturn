import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __PKG_VERSION__: JSON.stringify(version) },
  entry: { index: "src/index.ts", react: "src/react.tsx" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  external: ["openai", "@anthropic-ai/sdk", "ai", "@ai-sdk/provider", "react", "react/jsx-runtime"],
});
