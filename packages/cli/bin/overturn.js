#!/usr/bin/env node
// Thin launcher so the bin exists before `pnpm build` (pnpm links bins at install time).
import("../dist/index.js").catch((err) => {
  if (err && err.code === "ERR_MODULE_NOT_FOUND") {
    console.error("overturn: the CLI is not built yet. Run `pnpm build` (or install the published package).");
    process.exit(1);
  }
  throw err;
});
