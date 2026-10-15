/**
 * Records the loop (run -> correct -> case -> replay -> report) in a real browser and writes
 * docs/assets/loop.gif. Needs: the web app built, an API with seeded runs, Playwright and Pillow.
 *
 *   OVERTURN_API_URL=http://127.0.0.1:4000 OVERTURN_API_KEY=ov_live_... \
 *   PLAYWRIGHT_CHROMIUM_PATH=... node scripts/record-loop.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const API = process.env.OVERTURN_API_URL ?? "http://127.0.0.1:4000";
const KEY = process.env.OVERTURN_API_KEY;
const OUT = path.resolve(process.cwd(), "../../docs/assets/loop.gif");
if (!KEY) throw new Error("OVERTURN_API_KEY is required");

const port = 3900;
const web = spawn(
  "node",
  ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"],
  {
    env: { ...process.env, OVERTURN_API_URL: API, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  },
);
await new Promise((r) => setTimeout(r, 4000));

// sign in: request a magic link for the bootstrap user, exchange the token for a cookie
const link = await fetch(`${API}/v1/auth/magic-link`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "you@example.com" }),
}).then((r) => r.json());
const token = new URL(link.devUrl).searchParams.get("token");

const videoDir = mkdtempSync(path.join(tmpdir(), "overturn-gif-"));
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
);
const context = await browser.newContext({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
// frames instead of Playwright's video recorder (which needs its own ffmpeg build)
let frame = 0;
let capturing = true;
const capture = async () => {
  while (capturing) {
    try {
      await page.screenshot({ path: path.join(videoDir, `${String(frame++).padStart(4, "0")}.png`) });
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
};
const captureLoop = capture();
const pause = (ms) => page.waitForTimeout(ms);

await page.goto(`http://127.0.0.1:${port}/login/verify?token=${token}`);
await page.waitForURL(/\/runs$/);
await page.getByRole("link", { name: "ticket-triage" }).first().waitFor();
await pause(1500);

// 1. a run and its trajectory
await page.getByRole("link", { name: "ticket-triage" }).nth(3).click();
await page.getByTestId("step-2").waitFor();
await pause(800);
await page.getByTestId("step-2").click();
await pause(1800);

// 2. correct the model step
await page.getByTestId("step-2").getByRole("button", { name: "Correct" }).click();
await page.getByText(/Correct step 2/).waitFor();
await pause(900);
await page.getByRole("button", { name: /^Edit/ }).click();
await pause(600);
const editor = page.locator("textarea").first();
const current = await editor.inputValue();
await editor.fill(current.replace(/"priority": "P\d"/, '"priority": "P0"'));
await pause(500);
await page.locator("textarea").nth(1).type("Enterprise customer: outage keyword in body", { delay: 25 });
await pause(600);
await page.getByRole("button", { name: "Save edit" }).click();

// 3. the frozen case
await page.waitForURL(/\/cases\//);
await page.getByText("Expected (from the human)").waitFor();
await pause(1800);
await page.getByRole("tab", { name: /Tool recordings/ }).click();
await pause(1600);

// 4. replay against another model
await page.goto(`http://127.0.0.1:${port}/replays/new`);
await page.getByTestId("model").fill("fake/fake-triage-weak");
await page.getByText(/cases · estimated/).waitFor();
await pause(1200);
await page.getByTestId("start-replay").click();
await page.waitForURL(/\/replays\/[0-9a-f-]+$/);
await page.getByText("Pass rate").waitFor({ timeout: 60_000 });
await pause(1500);
await page.mouse.wheel(0, 500);
await pause(2500);

capturing = false;
await captureLoop;
await context.close();
await browser.close();
web.kill();

mkdirSync(path.dirname(OUT), { recursive: true });
// Assemble with Pillow (the Playwright ffmpeg build has no image demuxer).
execFileSync(
  "python3",
  [
    "-c",
    `
import sys, glob
from PIL import Image
frames = [Image.open(f).convert("RGB") for f in sorted(glob.glob(sys.argv[1] + "/*.png"))]
w = 960
frames = [f.resize((w, round(f.height * w / f.width)), Image.LANCZOS) for f in frames]
frames = [f.quantize(colors=128, method=Image.Quantize.MEDIANCUT) for f in frames]
frames[0].save(sys.argv[2], save_all=True, append_images=frames[1:], duration=200, loop=0)
print(len(frames), "frames")
`,
    videoDir,
    OUT,
  ],
  { stdio: "inherit" },
);
console.log(`wrote ${OUT}`);
process.exit(0);
