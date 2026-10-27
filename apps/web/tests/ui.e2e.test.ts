/**
 * The M6 acceptance test, in a real browser: a new user signs in with a magic link, sees
 * runs, corrects a step, launches a replay and reads the report. Runs the production Next
 * build against the API test harness and the example's fake model server.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const harness = await import("../../api/dist/test/harness.js");
const fakeOpenAI = await import("../../../examples/ticket-triage/src/fake-openai.js");
const seedMod = await import("../../../examples/ticket-triage/src/seed.js");
const sdk = await import("@overturn-ai/sdk");

let ctx: Awaited<ReturnType<typeof harness.startTestApp>>;
let fake: Awaited<ReturnType<typeof fakeOpenAI.startFakeOpenAI>>;
let web: ChildProcess;
let webUrl: string;
let browser: Browser;
let page: Page;

async function waitFor(url: string, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  fake = await fakeOpenAI.startFakeOpenAI(0);
  process.env.FAKE_OPENAI_URL = fake.url;
  ctx = await harness.startTestApp();
  // seed 30 runs with a key so the signed-in user has something to see; the user must be a member of that project
  const ov = new sdk.Overturn({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });
  await seedMod.seed(ov, { limit: 6 });
  await ov.shutdown();

  const port = 3100 + Math.floor(Math.random() * 500);
  webUrl = `http://127.0.0.1:${port}`;
  web = spawn(
    "node",
    [
      path.resolve(__dirname, "../node_modules/next/dist/bin/next"),
      "start",
      "-p",
      String(port),
      "-H",
      "127.0.0.1",
    ],
    {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, OVERTURN_API_URL: ctx.baseUrl, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  web.stderr?.on("data", (d: Buffer) => process.stderr.write(`[web] ${d}`));
  await waitFor(`${webUrl}/config`);
  // CI installs the browser (`playwright install chromium`); locally a preinstalled Chromium can be pointed at.
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  page = await browser.newPage({ baseURL: webUrl });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  web?.kill();
  await ctx?.close();
  fake?.server.close();
});

describe("web UI", () => {
  it("signs in, sees runs, corrects a step, launches a replay and reads the report", async () => {
    // --- sign in with a magic link (dev mode returns the link) ---
    await page.goto("/runs");
    await page.waitForURL(/\/login/);
    await page.fill("input#email", "test@example.com"); // the harness owner: member of the seeded project
    await page.click("button[type=submit]");
    const link = page.locator("a[href*='/login/verify']");
    await link.waitFor({ timeout: 15_000 });
    const href = await link.getAttribute("href");
    // the API builds links from WEB_URL (localhost:3000 by default); the test web server is on a random port
    await page.goto(`/login/verify?token=${new URL(href!).searchParams.get("token")}`);
    await page.waitForURL(/\/runs$/, { timeout: 15_000 });

    // --- runs page: the two numbers and the list ---
    await page.getByText("Human-corrected rate, last 7 days").waitFor();
    await page.getByRole("link", { name: "ticket-triage" }).first().waitFor({ timeout: 15_000 });
    expect(await page.getByRole("link", { name: "ticket-triage" }).count()).toBe(6);

    // --- run detail: timeline + Correct on an llm_call step ---
    await page.getByRole("link", { name: "ticket-triage" }).first().click();
    await page.waitForURL(/\/runs\/[0-9a-f-]+$/);
    await page.getByText("Trajectory").waitFor();
    await page.getByTestId("step-2").waitFor();
    expect(await page.getByTestId("replay-readiness").textContent()).toMatch(
      /replay-ready.*model step.*tool recordings/,
    );
    expect(await page.locator("li").filter({ hasText: "lookup_customer" }).count()).toBeGreaterThan(0);
    await page.getByTestId("step-2").getByRole("button", { name: "Correct" }).click();
    await page.getByText("Correct step 2: chat.completions").waitFor();
    // the answer mixes a decision (priority, team) with prose (reply): the dialog proposes scoring the decision
    const scored = page.getByTestId("scored-fields");
    await scored.waitFor();
    const proposed = (await scored.locator("input").inputValue()).split(", ").sort();
    expect(proposed).toEqual(["priority", "team"]);
    expect(await scored.textContent()).toContain("Not scored");
    await page.getByRole("button", { name: /^Edit/ }).click();
    const editor = page.locator("textarea").first();
    await editor.fill(JSON.stringify({ priority: "P0" }));
    await page.locator("textarea").nth(1).fill("Enterprise customer, outage keyword in body");
    // a rule set while the reviewer has the context: the tool names come from the run
    const rules = page.getByTestId("rules");
    await rules.getByTestId("contract-count").selectOption("never");
    await rules.getByTestId("contract-tool").selectOption("set_priority");
    await rules.getByTestId("contract-add").click();
    await rules.getByText("never call set_priority").waitFor();
    await page.getByRole("button", { name: "Save edit" }).click();

    // --- lands on the case ---
    await page.waitForURL(/\/cases\/[0-9a-f-]+$/, { timeout: 15_000 });
    await page.getByText("Expected (from the human)").waitFor();
    expect(await page.locator("pre").first().textContent()).toContain('"priority": "P0"');
    await page.getByTestId("case-contract").getByText("never call set_priority").waitFor();
    await page.getByRole("tab", { name: /Tool recordings \(4\)/ }).click();
    await page.getByText("side effect · refused in replay").first().waitFor();

    // --- cases list ---
    await page.goto("/cases");
    await page.getByText("edit: ticket-triage").waitFor();

    // --- a one-off correction from the Slack "Approve" deep link: case kept but archived ---
    await page.goto("/runs");
    await page.getByRole("link", { name: "ticket-triage" }).nth(1).click();
    await page.waitForURL(/\/runs\/[0-9a-f-]+$/);
    await page.goto(`${page.url()}?approve=1`);
    await page.getByText("Correct this run").waitFor();
    await page.getByTestId("one-off").check();
    await page.getByRole("button", { name: "Save approve" }).click();
    await page.waitForURL(/\/cases\/[0-9a-f-]+$/, { timeout: 15_000 });
    await page.getByText("archived").first().waitFor();
    await page.goto("/cases");
    expect(await page.getByText("approve: ticket-triage").count()).toBe(0); // active filter hides it

    // --- "Replay this case" preselects the case; the cases list link carries its filters ---
    await page.goto("/cases");
    await page.getByText("edit: ticket-triage").click();
    await page.waitForURL(/\/cases\/[0-9a-f-]+$/);
    await page.getByRole("link", { name: "Replay this case" }).click();
    await page.waitForURL(/\/replays\/new\?ids=/);
    await page.getByTestId("selected-cases").waitFor();
    expect(await page.getByTestId("selected-cases").textContent()).toContain("1 selected case");

    // --- new replay against the fake model ---
    await page.goto("/replays/new");
    await page.getByTestId("model").fill("fake/fake-triage-weak");
    await page.getByText(/1 cases · estimated/).waitFor({ timeout: 15_000 });
    await page.getByTestId("start-replay").click();
    await page.waitForURL(/\/replays\/[0-9a-f-]+$/, { timeout: 15_000 });
    await page.getByText("Pass rate").waitFor({ timeout: 30_000 });
    await page
      .getByRole("heading", { name: /Regressions|Still wrong|Fixed/ })
      .first()
      .waitFor();
    const pageText = await page.textContent("main");
    expect(pageText).toMatch(/Baseline/);
    expect(pageText).toMatch(/Human correction/);
    await page.getByTestId("gate").waitFor();

    // --- suppress from the report, see the count, restore from the list ---
    await page.getByTestId("suppress-case").first().click();
    await page.getByText("Suppressed").first().waitFor();
    await page.goto("/cases");
    await page.getByTestId("suppressed-note").waitFor();
    expect(await page.getByTestId("suppressed-note").textContent()).toContain("1 case suppressed");
    await page.getByTestId("suppressed-note").getByRole("button", { name: "Review them" }).click();
    await page.getByTestId("restore-case").first().click();
    await page.getByText("edit: ticket-triage").waitFor();
    await page.goto("/cases");
    expect(await page.getByTestId("suppressed-note").count()).toBe(0);

    // --- settings: mint an API key ---
    await page.goto("/settings");
    await page.getByTestId("create-key").click();
    await page.getByTestId("new-key").waitFor();
    expect(await page.getByTestId("new-key").textContent()).toContain("OVERTURN_API_KEY=ov_live_");
    await page.getByText("test@example.com").first().waitFor();
  }, 120_000);

  it("a brand-new workspace gets the onboarding panel; the first recorded run replaces it", async () => {
    const fresh = await browser.newPage({ baseURL: page.url().replace(/\/runs.*$/, "") });
    await fresh.goto("/login");
    await fresh.fill("input#email", "newbie@example.com"); // unknown email -> new workspace, zero runs
    await fresh.click("button[type=submit]");
    const link = fresh.locator("a[href*='/login/verify']");
    await link.waitFor({ timeout: 15_000 });
    const href = await link.getAttribute("href");
    await fresh.goto(`/login/verify?token=${new URL(href!).searchParams.get("token")}`);
    await fresh.waitForURL(/\/runs$/, { timeout: 15_000 });
    await fresh.getByTestId("onboarding").waitFor({ timeout: 15_000 });
    await fresh.getByTestId("onboarding-create-key").click();
    const key = (await fresh.getByTestId("onboarding-key").textContent())!.trim();
    expect(key).toMatch(/^ov_live_/);
    expect(await fresh.locator("pre").textContent()).toContain(`OVERTURN_API_KEY=${key}`);
    // record a run with that key, as the snippet would
    const res = await fetch(`${ctx.baseUrl}/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        v: 1,
        runs: [
          {
            id: "01a14000-0000-7000-8000-00000000aaaa",
            agent: "my-agent",
            status: "completed",
            startedAt: new Date().toISOString(),
            output: "ok",
          },
        ],
        steps: [],
      }),
    });
    expect(res.status).toBe(202);
    await fresh.getByRole("link", { name: "my-agent" }).waitFor({ timeout: 15_000 });
    expect(await fresh.getByTestId("onboarding").count()).toBe(0);
    // sign out from the account menu
    await fresh.getByTestId("account-menu").click();
    await fresh.getByTestId("sign-out").click();
    await fresh.waitForURL(/\/login/, { timeout: 15_000 });
    await fresh.close();
  }, 60_000);
});
