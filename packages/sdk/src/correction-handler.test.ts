import { describe, expect, it, vi } from "vitest";
import { createCorrectionHandler } from "./correction-handler.js";

const runId = "01a14c81-adc1-749a-a32c-3d5c8017bd53";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://app/api/overturn/correct", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("createCorrectionHandler", () => {
  it("validates, resolves the actor from the request and calls ov.correct", async () => {
    const correct = vi.fn(async (input: unknown) => ({ correction: input, case: { id: "c1" } }));
    const handler = createCorrectionHandler(
      { correct: correct as never },
      { actor: (req) => req.headers.get("x-user") },
    );
    const res = await handler(
      post(
        { runId, kind: "edit", correctedOutput: { priority: "P0" }, note: "outage" },
        { "x-user": "sam@x.io" },
      ),
    );
    expect(res.status).toBe(200);
    expect(correct).toHaveBeenCalledWith({
      runId,
      stepId: null,
      kind: "edit",
      correctedOutput: { priority: "P0" },
      note: "outage",
      actor: "sam@x.io",
    });
    expect(((await res.json()) as { case: { id: string } }).case.id).toBe("c1");
  });

  it("rejects bad methods, bad JSON and bad bodies without calling ov.correct", async () => {
    const correct = vi.fn();
    const handler = createCorrectionHandler({ correct: correct as never });
    expect((await handler(new Request("http://app/x", { method: "GET" }))).status).toBe(405);
    expect((await handler(post("{nope"))).status).toBe(400);
    const bad = await handler(post({ runId: "not-a-uuid", kind: "approve" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid correction");
    expect((await handler(post({ runId, kind: "undo" }))).status).toBe(400);
    expect(correct).not.toHaveBeenCalled();
  });

  it("lets the actor callback refuse with its own Response and maps API failures to 502", async () => {
    const refuse = createCorrectionHandler(
      { correct: vi.fn() as never },
      { actor: () => new Response("sign in", { status: 401 }) },
    );
    expect((await refuse(post({ runId, kind: "approve" }))).status).toBe(401);
    const failing = createCorrectionHandler({
      correct: vi.fn(async () => {
        throw new Error("run not found");
      }) as never,
    });
    const res = await failing(post({ runId, kind: "approve" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("run not found");
  });
});
