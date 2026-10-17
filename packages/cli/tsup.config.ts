import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __PKG_VERSION__: JSON.stringify(version) },
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  // bundle workspace packages so `npx overturn` works standalone
  noExternal: ["@overturn-ai/sdk", "@overturn-ai/shared"],
});
