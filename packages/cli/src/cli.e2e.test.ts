import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProgram } from "./index.js";

const harness = await import("../../../apps/api/dist/test/harness.js");

let ctx: Awaited<ReturnType<typeof harness.startTestApp>>;
beforeAll(async () => {
  ctx = await harness.startTestApp();
});
afterAll(async () => {
  await ctx.close();
});

async function run(args: string[]): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await buildProgram().parseAsync([
      "node",
      "overturn",
      "--api-key",
      ctx.apiKey,
      "--base-url",
      ctx.baseUrl,
      ...args,
    ]);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

describe("overturn CLI", () => {
  it("init writes .env and overturn.config.ts and verifies the key", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "overturn-cli-"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const out = await run(["init"]);
      expect(out).toContain("key verified for project test");
      expect(readFileSync(path.join(dir, ".env"), "utf8")).toContain(`OVERTURN_API_KEY=${ctx.apiKey}`);
      expect(readFileSync(path.join(dir, "overturn.config.ts"), "utf8")).toContain("defineConfig");
    } finally {
      process.chdir(cwd);
    }
  });

  it("runs list and cases list render tables and JSON", async () => {
    expect(await run(["runs", "list"])).toContain("no runs");
    await harness.api(ctx, "POST", "/v1/ingest", {
      v: 1,
      runs: [
        {
          id: "01a14000-0000-7000-8000-000000000001",
          agent: "cli-agent",
          status: "completed",
          startedAt: new Date().toISOString(),
        },
      ],
      steps: [
        {
          id: "01a14000-0000-7000-8000-000000000002",
          runId: "01a14000-0000-7000-8000-000000000001",
          seq: 0,
          kind: "llm_call",
          name: "chat.completions",
          model: "m",
          input: { messages: [] },
          output: { message: { role: "assistant", content: "ok" } },
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const tableOut = await run(["runs", "list", "--agent", "cli-agent"]);
    expect(tableOut).toContain("cli-agent");
    const json = JSON.parse(await run(["--json", "runs", "list", "--since", "1h"])) as { items: unknown[] };
    expect(json.items).toHaveLength(1);
    await harness.api(ctx, "POST", "/v1/corrections", {
      runId: "01a14000-0000-7000-8000-000000000001",
      kind: "approve",
    });
    const cases = await run(["cases", "list"]);
    expect(cases).toContain("approve");
    expect(cases).toContain("equals");
    const get = await run(["runs", "get", "01a14000-0000-7000-8000-000000000001"]);
    expect(get).toContain("chat.completions");
  });
});

describe("overturn replay / report", () => {
  it("runs a step replay against the fake provider and prints the report", async () => {
    const { startFakeOpenAI, echoModel } = await import("../../../apps/api/dist/test/fake-openai.js");
    const fake = await startFakeOpenAI();
    process.env.FAKE_OPENAI_URL = fake.url;
    try {
      const runId = "01a14000-0000-7000-8000-000000000011";
      await harness.api(ctx, "POST", "/v1/ingest", {
        v: 1,
        runs: [
          {
            id: runId,
            agent: "replay-cli",
            status: "completed",
            output: { priority: "P1" },
            startedAt: new Date().toISOString(),
          },
        ],
        steps: [
          {
            id: "01a14000-0000-7000-8000-000000000012",
            runId,
            seq: 0,
            kind: "llm_call",
            name: "chat.completions",
            model: "m",
            input: { messages: [{ role: "user", content: "triage" }] },
            output: { message: { role: "assistant", content: '{"priority":"P1"}' } },
            startedAt: new Date().toISOString(),
          },
        ],
      });
      await harness.api(ctx, "POST", "/v1/corrections", { runId, kind: "approve" });
      const out = await run([
        "replay",
        "--model",
        echoModel({ priority: "P2" }),
        "--agent",
        "replay-cli",
        "--format",
        "md",
        "-y",
      ]);
      expect(out).toContain("### Regressions (1)");
      const jobs = JSON.parse(await run(["--json", "replays", "list"])) as Array<{
        id: string;
        status: string;
      }>;
      expect(jobs[0]!.status).toBe("completed");
      const report = await run(["report", jobs[0]!.id]);
      expect(report).toContain("regression");
      const asJson = JSON.parse(await run(["--json", "report", jobs[0]!.id])) as { regressions: unknown[] };
      expect(asJson.regressions).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });
});
