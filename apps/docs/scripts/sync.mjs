// Pulls the repo's docs/*.md into the site at build time: one source of truth, no drift.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../../docs");
const out = path.resolve(here, "../src/content/docs");
mkdirSync(out, { recursive: true });

const pages = [
  ["quickstart.md", "quickstart.md", "Ten minutes from clone to a replay report that shows a regression."],
  ["sdk.md", "sdk.md", "TypeScript and Python SDKs, the CLI and the REST API."],
  ["self-hosting.md", "self-hosting.md", "docker compose, Railway, environment variables, operations."],
  ["fingerprint.md", "fingerprint.md", "How tool calls are matched to recordings during replay."],
  [
    "owned-models.md",
    "owned-models.md",
    "Export, corrections in the prompt, challengers, train and gate, shadow, promote.",
  ],
];
for (const [file, target, description] of pages) {
  let md = readFileSync(path.join(src, file), "utf8");
  const m = md.match(/^# (.+)\n/);
  const title = m ? m[1] : file;
  md = md.replace(/^# .+\n/, "");
  // repo-relative links -> site links
  md = md
    .replace(/\]\(docs\/([a-z-]+)\.md\)/g, "](/docs/$1/)")
    .replace(/\]\(([a-z-]+)\.md\)/g, "](/docs/$1/)")
    .replace(/\]\(docs\/assets\//g, "](/");
  const fm = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
  writeFileSync(path.join(out, target), fm + md);
}
console.log(`synced ${pages.length} pages`);
