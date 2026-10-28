import type { CaptureResult, IngestPayload, RunWithSteps } from "@overturn-ai/shared";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, startTestApp, type TestContext } from "../test/harness";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.close();
});

const thread = [
  {
    role: "customer" as const,
    author: "dana@example.com",
    content: "Water came through the ceiling after the storm on the 3rd. Photos attached.",
  },
  { role: "note" as const, content: "HO-3, deductible $1,000, no prior claims." },
];

const draft =
  "Hi Dana, thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. We've opened claim 48213 and an adjuster will contact you within 5 business days. Your $1,000 deductible applies.";

describe("POST /v1/capture", () => {
  it("an edited reply becomes a run, an edit correction and a case with the reason as rubric", async () => {
    const sent =
      "Hi Dana, thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. We've opened claim 48213 and an adjuster will contact you within 2 business days. Your $1,000 deductible applies. Please keep the damaged shingles for inspection.";
    const res = await api<CaptureResult>(ctx, "POST", "/v1/capture", {
      source: "zendesk",
      externalId: "zd:48213",
      agent: "claims-reply",
      actor: "ray@carrier.com",
      subject: "Roof leak after storm",
      context: thread,
      draft: { text: draft },
      sent: { text: sent },
      reason: "Storm claims get 2-day contact; ask to keep evidence",
      draftModel: "gpt-4.1-mini",
      draftProvider: "openai",
      url: "https://carrier.zendesk.com/agent/tickets/48213",
    });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("edit");
    expect(res.body.changed).toBe(true);
    expect(res.body.changedFields).toEqual([]);
    expect(res.body.correction).toMatchObject({ kind: "edit", actor: "ray@carrier.com", source: "capture" });
    expect(res.body.case).toMatchObject({
      agent: "claims-reply",
      kind: "edit",
      expected: sent,
      scorer: "judge",
      recordedModel: "gpt-4.1-mini",
    });
    expect(res.body.case?.title).toContain("Storm claims get 2-day contact");

    const run = await api<RunWithSteps>(ctx, "GET", `/v1/runs/${res.body.runId}`);
    expect(run.status).toBe(200);
    expect(run.body.externalId).toBe("zd:48213");
    expect(run.body.tags).toContain("capture:zendesk");
    expect(run.body.steps).toHaveLength(1);
    const step = run.body.steps[0]!;
    expect(step.kind).toBe("llm_call");
    const messages = (step.input as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.content).toContain("Subject: Roof leak after storm");
    expect(messages[1]!.content).toContain("Customer (dana@example.com)");
    expect((step.output as { message: { content: string } }).message.content).toBe(draft);
  });

  it("a reply sent as drafted is an approve with no prompt for a reason", async () => {
    const res = await api<CaptureResult>(ctx, "POST", "/v1/capture", {
      source: "front",
      externalId: "front:cnv_1",
      agent: "claims-reply",
      context: thread,
      draft: { text: draft },
      sent: { text: `${draft}\n` },
    });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("approve");
    expect(res.body.changed).toBe(false);
    expect(res.body.case?.expected).toBe(draft);
  });

  it("decision fields are scored exactly and the prose is left to the judge", async () => {
    const res = await api<CaptureResult>(ctx, "POST", "/v1/capture", {
      source: "zendesk",
      externalId: "zd:9",
      agent: "coverage-decision",
      context: thread,
      draft: { text: draft, fields: { status: "covered", reserve: 4000, denial_reason: null } },
      sent: { text: draft, fields: { status: "covered", reserve: 6500, denial_reason: null } },
      reason: "Roof replacement, not repair",
    });
    expect(res.status).toBe(201);
    expect(res.body.changed).toBe(true);
    expect(res.body.changedFields).toEqual(["reserve"]);
    expect(res.body.case?.expected).toEqual({
      status: "covered",
      reserve: 6500,
      denial_reason: null,
      reply: draft,
    });
    expect(res.body.case?.scorer).toBe("json_match");
    expect(res.body.case?.scorerConfig).toMatchObject({ auto: true });
    const fields = (res.body.case!.scorerConfig as { fields: string[] }).fields;
    expect(fields).toContain("reserve");
    expect(fields).toContain("status");
    expect(fields).not.toContain("reply");
  });

  it("attaches to the drafting agent's own run when it recorded the draft", async () => {
    const runId = uuidv7();
    const stepId = uuidv7();
    const payload: IngestPayload = {
      v: 1,
      runs: [
        {
          id: runId,
          agent: "claims-reply",
          externalId: "zd:777",
          status: "completed",
          output: draft,
          startedAt: "2026-10-20T10:00:00.000Z",
          endedAt: "2026-10-20T10:00:01.000Z",
        },
      ],
      steps: [
        {
          id: stepId,
          runId,
          seq: 0,
          kind: "llm_call",
          name: "chat.completions",
          model: "gpt-4.1-mini",
          provider: "openai",
          input: { messages: [{ role: "user", content: "draft a reply" }] },
          output: { message: { role: "assistant", content: draft }, finish_reason: "stop" },
          startedAt: "2026-10-20T10:00:00.000Z",
        },
      ],
    };
    expect((await api(ctx, "POST", "/v1/ingest", payload)).status).toBe(202);

    // Found by externalId + agent + the same draft: no synthetic run.
    const res = await api<CaptureResult>(ctx, "POST", "/v1/capture", {
      source: "zendesk",
      externalId: "zd:777",
      agent: "claims-reply",
      context: thread,
      draft: { text: draft },
      sent: { text: "Denied: damage predates the policy start date." },
      reason: "Loss date before inception",
    });
    expect(res.status).toBe(201);
    expect(res.body.runId).toBe(runId);
    expect(res.body.stepId).toBe(stepId);

    // The capture surface finds the drafting agent's run by externalId.
    const byExt = await api<{ items: Array<{ id: string }> }>(ctx, "GET", "/v1/runs?externalId=zd%3A777");
    expect(byExt.status).toBe(200);
    expect(byExt.body.items.map((r) => r.id)).toEqual([runId]);

    // Explicit draftRunId works the same way.
    const res2 = await api<CaptureResult>(ctx, "POST", "/v1/capture", {
      externalId: "zd:777",
      agent: "claims-reply",
      draftRunId: runId,
      draft: { text: draft },
      sent: { text: draft },
    });
    expect(res2.status).toBe(201);
    expect(res2.body.runId).toBe(runId);
    expect(res2.body.kind).toBe("approve");

    const missing = await api(ctx, "POST", "/v1/capture", {
      externalId: "zd:778",
      draftRunId: uuidv7(),
      draft: { text: "a" },
      sent: { text: "b" },
    });
    expect(missing.status).toBe(404);
  });

  it("the same fix on the same thread twice is one case", async () => {
    const body = {
      source: "zendesk",
      externalId: "zd:dup",
      agent: "claims-reply",
      context: thread,
      draft: { text: draft },
      sent: { text: "Covered. Adjuster within 2 days." },
    };
    const a = await api<CaptureResult>(ctx, "POST", "/v1/capture", body);
    const b = await api<CaptureResult>(ctx, "POST", "/v1/capture", body);
    expect(a.body.deduplicated).toBe(false);
    expect(b.body.deduplicated).toBe(true);
    expect(b.body.case?.id).toBe(a.body.case?.id);
  });

  it("rejects a capture without a draft", async () => {
    const res = await api(ctx, "POST", "/v1/capture", { externalId: "zd:1", sent: { text: "x" } });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/capture/stats", () => {
  it("counts untouched vs edited, by expert, reason, source and week", async () => {
    const stats = await api<import("@overturn-ai/shared").CaptureStats>(
      ctx,
      "GET",
      "/v1/capture/stats?days=30",
    );
    expect(stats.status).toBe(200);
    const s = stats.body;
    expect(s.captures).toBeGreaterThanOrEqual(6);
    expect(s.untouched + s.edited).toBe(s.captures);
    expect(s.untouchedRate).toBeCloseTo(s.untouched / s.captures, 5);
    expect(s.experts).toBeGreaterThanOrEqual(1);
    const ray = s.byActor.find((a) => a.actor === "ray@carrier.com");
    expect(ray).toMatchObject({ captures: 1, edited: 1, untouchedRate: 0 });
    expect(s.byReason.map((r) => r.reason)).toContain("storm claims get 2-day contact; ask to keep evidence");
    expect(s.bySource.find((x) => x.source === "zendesk")?.count).toBeGreaterThanOrEqual(3);
    expect(s.bySource.find((x) => x.source === "front")?.count).toBe(1);
    expect(s.byAgent.find((a) => a.agent === "claims-reply")?.captures).toBeGreaterThanOrEqual(4);
    expect(s.weekly.length).toBeGreaterThanOrEqual(1);
    expect(s.weekly.reduce((n, w) => n + w.captures, 0)).toBe(s.captures);

    const filtered = await api<import("@overturn-ai/shared").CaptureStats>(
      ctx,
      "GET",
      "/v1/capture/stats?days=30&agent=coverage-decision",
    );
    expect(filtered.body.captures).toBe(1);
    expect(filtered.body.edited).toBe(1);
  });
});
