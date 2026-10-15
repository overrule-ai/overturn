import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  // bundle workspace packages so `npx overturn` works standalone
  noExternal: ["@overturn/sdk", "@overturn/shared"],
});
