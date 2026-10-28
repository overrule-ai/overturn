import type { CorrectionResult, IngestPayload, TrainedModel } from "@overturn-ai/shared";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { echoModel, startFakeOpenAI } from "../test/fake-openai";
import { api, startTestApp, type TestContext } from "../test/harness";
import { TrainingService } from "./training.service";

let ctx: TestContext;
let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
let training: TrainingService;

beforeAll(async () => {
  fake = await startFakeOpenAI();
  process.env.FAKE_OPENAI_URL = fake.url;
  process.env.TOGETHER_API_KEY = "fake-together-key";
  process.env.TOGETHER_BASE_URL = fake.url;
  ctx = await startTestApp();
  training = ctx.app.get(TrainingService);
});
afterAll(async () => {
  await ctx.close();
  await fake.close();
});

async function recordRun(externalId: string, decision: Record<string, unknown>, agent: string) {
  const runId = uuidv7();
  const t0 = new Date().toISOString();
  const payload: IngestPayload = {
    v: 1,
    runs: [
      {
        id: runId,
        agent,
        externalId,
        status: "completed",
        input: { id: externalId },
        output: decision,
        startedAt: t0,
        endedAt: t0,
      },
    ],
    steps: [
      {
        id: uuidv7(),
        runId,
        seq: 0,
        kind: "llm_call",
        name: "chat.completions",
        model: "fake-triage-v1",
        provider: "openai",
        input: {
          messages: [
            { role: "system", content: "triage" },
            { role: "user", content: JSON.stringify({ id: externalId, body: `ticket ${externalId}` }) },
          ],
        },
        params: { temperature: 0 },
        output: { message: { role: "assistant", content: JSON.stringify(decision) }, finish_reason: "stop" },
        startedAt: t0,
      },
    ],
  };
  const res = await api(ctx, "POST", "/v1/ingest", payload);
  expect(res.status).toBe(202);
  return runId;
}

describe("train and gate", () => {
  it("refuses to train on too few corrections and points at corrections-in-the-prompt", async () => {
    const r = await recordRun("TR-0", { priority: "P1" }, "tiny-agent");
    await api(ctx, "POST", "/v1/corrections", { runId: r, kind: "approve" });
    const res = await api<{ message: string }>(ctx, "POST", "/v1/models", {
      baseModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Reference",
      filter: { agent: "tiny-agent" },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/under the 50 needed/);
    expect(res.body.message).toMatch(/--examples 5/);
  });

  it("exports, fine-tunes, gates against the suite, and only a human promotes", async () => {
    // 6 approved runs; the fake fine-tune's output model echoes P1, so every approve case passes
    for (let i = 0; i < 6; i++) {
      const r = await recordRun(`TR-${i + 1}`, { priority: "P1" }, "train-agent");
      await api<CorrectionResult>(ctx, "POST", "/v1/corrections", { runId: r, kind: "approve" });
    }
    const name = echoModel({ priority: "P1" }).slice("fake/".length); // echo-<b64>: the fake serves it back
    const created = await api<TrainedModel>(ctx, "POST", "/v1/models", {
      baseModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Reference",
      filter: { agent: "train-agent" },
      epochs: 2,
      minRows: 5,
      name,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("exporting");
    expect(created.body.datasetStats!.rows).toBe(6);

    const done = await training.runToCompletion(created.body.id, 10);
    expect(done.status).toBe("passed");
    expect(done.providerJobId).toBe("ft-fake-1");
    expect(done.outputName).toContain(name);
    expect(done.servedAs).toBe(`together/${done.outputName}`);
    expect(done.gate).toMatchObject({ pass: true, regressions: 0, newPaths: 0, passRate: 1 });
    expect(done.gate!.replayJobId).toBeTruthy();
    // the upload carried the dataset and the fine-tune request was LoRA SFT
    const ft = fake.calls.find((c) => c.fineTune) as { fineTune: Record<string, unknown> };
    expect(ft.fineTune.model).toBe("meta-llama/Meta-Llama-3.1-8B-Instruct-Reference");
    expect(ft.fineTune.n_epochs).toBe(2);
    expect((ft.fineTune.training_type as { type: string }).type).toBe("Lora");

    // nothing is promoted by itself
    const listed = await api<TrainedModel[]>(ctx, "GET", "/v1/models");
    expect(listed.body.map((m) => m.status)).toContain("passed");
    const project = await api<{ settings: { promotedModel: string | null } }>(ctx, "GET", "/v1/project");
    expect(project.body.settings.promotedModel).toBeNull();

    // shadow mode: live runs get answered by the candidate; agreement is known at once
    await api(ctx, "PATCH", `/v1/models/${done.id}`, { shadow: true });
    await new Promise((r) => setTimeout(r, 20));
    const live = await recordRun("LIVE-1", { priority: "P1" }, "train-agent");
    const live2 = await recordRun("LIVE-2", { priority: "P3" }, "train-agent");
    expect(await training.shadowSweep()).toBe(2);
    let m = await api<TrainedModel>(ctx, "GET", `/v1/models/${done.id}`);
    expect(m.body.shadowStats).toMatchObject({ runs: 2, agreesWithProduction: 1, scored: 0 });
    // a human corrects the one it disagreed on — to what the shadow said
    await api(ctx, "POST", "/v1/corrections", {
      runId: live2,
      kind: "edit",
      correctedOutput: { priority: "P1" },
    });
    await api(ctx, "POST", "/v1/corrections", { runId: live, kind: "approve" });
    expect(await training.shadowScoreSweep()).toBe(2);
    m = await api<TrainedModel>(ctx, "GET", `/v1/models/${done.id}`);
    expect(m.body.shadowStats).toMatchObject({ scored: 2, passed: 2, passRate: 1 });

    // promote: a human's click
    const promoted = await api<TrainedModel>(ctx, "POST", `/v1/models/${done.id}/promote`);
    expect(promoted.body.status).toBe("promoted");
    const after = await api<{ settings: { promotedModel: string | null } }>(ctx, "GET", "/v1/project");
    expect(after.body.settings.promotedModel).toBe(done.servedAs);
    const retired = await api<TrainedModel>(ctx, "POST", `/v1/models/${done.id}/retire`);
    expect(retired.body.status).toBe("retired");
    const cleared = await api<{ settings: { promotedModel: string | null } }>(ctx, "GET", "/v1/project");
    expect(cleared.body.settings.promotedModel).toBeNull();
  });

  it("a failed gate cannot be promoted", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await recordRun(`BAD-${i}`, { priority: "P1" }, "bad-agent");
      await api(ctx, "POST", "/v1/corrections", { runId: r, kind: "approve" });
    }
    const name = echoModel({ priority: "P3" }).slice("fake/".length);
    const created = await api<TrainedModel>(ctx, "POST", "/v1/models", {
      baseModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Reference",
      filter: { agent: "bad-agent" },
      minRows: 5,
      name,
    });
    const done = await training.runToCompletion(created.body.id, 10);
    expect(done.status).toBe("failed");
    expect(done.gate!.regressions).toBe(5);
    const res = await api<{ message: string }>(ctx, "POST", `/v1/models/${done.id}/promote`);
    expect(res.status).toBe(400);
  });
});
