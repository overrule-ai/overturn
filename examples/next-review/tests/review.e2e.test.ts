/**
 * The CorrectButton recipe in a real Next.js app: production build, the API test harness,
 * a browser clicking Approve, a case appearing in Overturn.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const harness = await import("../../../apps/api/dist/test/harness.js");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let ctx: Awaited<ReturnType<typeof harness.startTestApp>>;
let web: ChildProcess;
let browser: Browser;
const port = 3190;
const webUrl = `http://127.0.0.1:${port}`;

async function waitFor(url: string, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  ctx = await harness.startTestApp();
  await harness.api(ctx, "POST", "/v1/ingest", {
    v: 1,
    runs: [
      {
        id: "01a14000-0000-7000-8000-00000000c0de",
        agent: "support-agent",
        externalId: "T-77",
        status: "completed",
        input: { subject: "Refund" },
        output: { priority: "P2", team: "billing", reply: "Refunded." },
        startedAt: new Date().toISOString(),
      },
    ],
    steps: [
      {
        id: "01a14000-0000-7000-8000-00000000c0df",
        runId: "01a14000-0000-7000-8000-00000000c0de",
        seq: 0,
        kind: "llm_call",
        name: "chat.completions",
        model: "m",
        input: { messages: [{ role: "user", content: "Refund" }] },
        output: {
          message: { role: "assistant", content: '{"priority":"P2","team":"billing","reply":"Refunded."}' },
        },
        startedAt: new Date().toISOString(),
      },
    ],
  });
  web = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env: {
      ...process.env,
      OVERTURN_API_KEY: ctx.apiKey,
      OVERTURN_BASE_URL: ctx.baseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  web.stderr?.on("data", (d: Buffer) => process.stderr.write(`[next] ${d}`));
  await waitFor(webUrl);
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
});
afterAll(async () => {
  await browser?.close();
  web?.kill();
  await ctx?.close();
});

describe("next-review", () => {
  it("lists runs and an Approve from <CorrectButton> becomes a case with the reviewer as actor", async () => {
    const page = await browser.newPage({ baseURL: webUrl, extraHTTPHeaders: { "x-reviewer": "sam@x.io" } });
    await page.goto("/");
    await page.getByTestId("run").first().waitFor();
    expect(await page.getByTestId("run").count()).toBe(1);
    await page.locator("[data-overturn=trigger]").click();
    await page.locator("[data-overturn=submit]").click(); // Approve is preselected
    await page.locator("[data-overturn=done]").waitFor();
    await page.getByText("1 correction").waitFor({ timeout: 15_000 }); // router.refresh() after onDone
    const cases = await harness.api<{ items: Array<{ kind: string; actor: string | null }> }>(
      ctx,
      "GET",
      "/v1/cases?agent=support-agent",
    );
    expect(cases.body.items).toHaveLength(1);
    expect(cases.body.items[0]).toMatchObject({ kind: "approve", actor: "sam@x.io" });
    await page.close();
  });
});
