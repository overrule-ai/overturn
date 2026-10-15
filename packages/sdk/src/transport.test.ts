import type { IngestPayload } from "@overturn/shared";
import { describe, expect, it } from "vitest";
import { buildPayload, Transport } from "./transport.js";

function fakeFetch(handler: (payload: IngestPayload, call: number) => number | Promise<number>) {
  const calls: IngestPayload[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as IngestPayload;
    calls.push(payload);
    const status = await handler(payload, calls.length);
    return new Response(status < 400 ? "{}" : "nope", { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const run = (id: string) => ({
  id,
  agent: "a",
  status: "running" as const,
  startedAt: new Date().toISOString(),
});

describe("buildPayload", () => {
  it("merges items with the same id, later defined fields win", () => {
    const p = buildPayload([
      { kind: "run", data: { ...run("r1"), input: { x: 1 } } },
      { kind: "run", data: { ...run("r1"), status: "completed", output: { y: 2 } } },
    ]);
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]).toMatchObject({ status: "completed", input: { x: 1 }, output: { y: 2 } });
    expect(p.v).toBe(1);
  });
});

describe("Transport", () => {
  it("batches and flushes", async () => {
    const { fetch, calls } = fakeFetch(() => 202);
    const t = new Transport({
      apiKey: "k",
      baseUrl: "http://x/",
      fetch,
      disableTimer: true,
      maxBatchSize: 3,
    });
    t.enqueueRun(run("r1"));
    t.enqueueRun(run("r2"));
    expect(calls).toHaveLength(0);
    t.enqueueRun(run("r3")); // hits maxBatchSize -> auto flush
    await t.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(t.stats.sent).toBe(3);
  });

  it("flushes on the timer", async () => {
    const { fetch, calls } = fakeFetch(() => 202);
    const t = new Transport({ apiKey: "k", baseUrl: "http://x", fetch, flushIntervalMs: 20 });
    t.enqueueRun(run("r1"));
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(1);
  });

  it("retries 5xx with backoff then succeeds", async () => {
    const { fetch, calls } = fakeFetch((_p, n) => (n < 3 ? 503 : 202));
    const errors: number[] = [];
    const t = new Transport({
      apiKey: "k",
      baseUrl: "http://x",
      fetch,
      disableTimer: true,
      backoffMs: 1,
      onError: (_e, c) => errors.push(c.attempt),
    });
    t.enqueueRun(run("r1"));
    await t.flush();
    expect(calls).toHaveLength(3);
    expect(errors).toEqual([0, 1]);
    expect(t.stats.retries).toBe(2);
    expect(t.stats.dropped).toBe(0);
  });

  it("does not retry 4xx and drops the batch", async () => {
    const { fetch, calls } = fakeFetch(() => 400);
    let dropped = false;
    const t = new Transport({
      apiKey: "k",
      baseUrl: "http://x",
      fetch,
      disableTimer: true,
      backoffMs: 1,
      onError: (_e, c) => {
        dropped = c.dropped;
      },
    });
    t.enqueueRun(run("r1"));
    await t.flush();
    expect(calls).toHaveLength(1);
    expect(dropped).toBe(true);
    expect(t.stats.dropped).toBe(1);
  });

  it("gives up after maxRetries and never throws", async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const t = new Transport({
      apiKey: "k",
      baseUrl: "http://x",
      fetch,
      disableTimer: true,
      backoffMs: 1,
      maxRetries: 2,
    });
    t.enqueueRun(run("r1"));
    await expect(t.flush()).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
    expect(t.stats.dropped).toBe(1);
  });

  it("drops the oldest items on queue overflow", async () => {
    const { fetch } = fakeFetch(() => 202);
    const t = new Transport({
      apiKey: "k",
      baseUrl: "http://x",
      fetch,
      disableTimer: true,
      maxQueueSize: 2,
      maxBatchSize: 100,
    });
    t.enqueueRun(run("r1"));
    t.enqueueRun(run("r2"));
    t.enqueueRun(run("r3"));
    expect(t.pending).toBe(2);
    expect(t.stats.dropped).toBe(1);
  });
});
