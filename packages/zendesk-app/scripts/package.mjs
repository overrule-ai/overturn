// Assembles the uploadable Zendesk app: manifest + assets + translations + the built script.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "assets"), { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });
cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "assets", "main.js"));
try {
  execFileSync("zip", ["-qr", path.join(root, "dist", "overturn-zendesk-app.zip"), "."], { cwd: out });
  console.log("dist/overturn-zendesk-app.zip");
} catch {
  console.log("dist/app (zip not available; upload the folder with zcli)");
}
