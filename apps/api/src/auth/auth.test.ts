import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestContext } from "../test/harness";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx.close();
});

async function signIn(email: string): Promise<string> {
  const link = await fetch(`${ctx.baseUrl}/v1/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(link.status).toBe(200);
  const { sent, devUrl } = (await link.json()) as { sent: boolean; devUrl: string | null };
  expect(sent).toBe(false); // no RESEND_API_KEY in tests
  const token = new URL(devUrl!).searchParams.get("token")!;
  const verify = await fetch(`${ctx.baseUrl}/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(verify.status).toBe(200);
  const cookie = verify.headers.get("set-cookie")!;
  expect(cookie).toContain("ov_session=");
  expect(cookie).toContain("HttpOnly");
  return cookie.split(";")[0]!;
}

describe("magic-link auth", () => {
  it("rate-limits link requests per address (5 per 10 minutes)", async () => {
    const ask = () =>
      fetch(`${ctx.baseUrl}/v1/auth/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "Spam@Example.com" }),
      });
    for (let i = 0; i < 5; i++) expect((await ask()).status).toBe(200);
    const blocked = await ask();
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { message: string }).message).toMatch(/Too many/);
    // other addresses are unaffected
    expect((await signIn("fine@example.com")).length).toBeGreaterThan(0);
  });

  it("signs a new user in, creates a workspace, and the session works on the API", async () => {
    const cookie = await signIn("Priya@Example.com");
    const session = await fetch(`${ctx.baseUrl}/v1/auth/session`, { headers: { cookie } });
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      user: { email: string };
      project: { name: string };
      projects: unknown[];
      via: string;
    };
    expect(body.user.email).toBe("priya@example.com");
    expect(body.project.name).toBe("default");
    expect(body.projects).toHaveLength(1);
    expect(body.via).toBe("session");

    // the session authenticates the public API like a key does
    const runs = await fetch(`${ctx.baseUrl}/v1/runs`, { headers: { cookie } });
    expect(runs.status).toBe(200);

    // keys can be minted from the UI session and used by SDKs
    const key = await fetch(`${ctx.baseUrl}/v1/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "ci" }),
    });
    expect(key.status).toBe(201);
    const { key: plaintext, id } = (await key.json()) as { key: string; id: string };
    expect(plaintext.startsWith("ov_live_")).toBe(true);
    const me = await fetch(`${ctx.baseUrl}/v1/me`, { headers: { authorization: `Bearer ${plaintext}` } });
    expect(me.status).toBe(200);
    const list = await fetch(`${ctx.baseUrl}/v1/api-keys`, { headers: { cookie } });
    expect(((await list.json()) as Array<{ name: string }>).map((k) => k.name)).toContain("ci");
    expect(
      (await fetch(`${ctx.baseUrl}/v1/api-keys/${id}`, { method: "DELETE", headers: { cookie } })).status,
    ).toBe(204);
    expect(
      (await fetch(`${ctx.baseUrl}/v1/me`, { headers: { authorization: `Bearer ${plaintext}` } })).status,
    ).toBe(401);
  });

  it("corrections made from the web app are attributed to the signed-in user", async () => {
    const cookie = await signIn("reviewer@example.com");
    const runId = "01a14100-0000-7000-8000-00000000a001";
    const key = await fetch(`${ctx.baseUrl}/v1/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "seed" }),
    });
    const { key: plaintext } = (await key.json()) as { key: string };
    const ingest = await fetch(`${ctx.baseUrl}/v1/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({
        v: 1,
        runs: [
          {
            id: runId,
            agent: "ui-agent",
            status: "completed",
            output: { ok: 1 },
            startedAt: new Date().toISOString(),
          },
        ],
        steps: [
          {
            id: "01a14100-0000-7000-8000-00000000a002",
            runId,
            seq: 0,
            kind: "llm_call",
            name: "chat",
            input: { messages: [] },
            output: { message: { role: "assistant", content: "ok" } },
            startedAt: new Date().toISOString(),
          },
        ],
      }),
    });
    expect(ingest.status).toBe(202);
    const corr = await fetch(`${ctx.baseUrl}/v1/corrections`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ runId, kind: "approve" }),
    });
    expect(corr.status).toBe(201);
    const { correction } = (await corr.json()) as { correction: { actor: string | null; source: string } };
    expect(correction.actor).toBe("reviewer@example.com");
    expect(correction.source).toBe("ui");
  });

  it("links are single-use and expire; logout revokes the session", async () => {
    const link = await fetch(`${ctx.baseUrl}/v1/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "sam@example.com" }),
    });
    const { devUrl } = (await link.json()) as { devUrl: string };
    const token = new URL(devUrl).searchParams.get("token")!;
    const first = await fetch(`${ctx.baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(first.status).toBe(200);
    const again = await fetch(`${ctx.baseUrl}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(again.status).toBe(401);
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (await fetch(`${ctx.baseUrl}/v1/auth/logout`, { method: "POST", headers: { cookie } })).status,
    ).toBe(204);
    expect((await fetch(`${ctx.baseUrl}/v1/auth/session`, { headers: { cookie } })).status).toBe(401);
    expect(
      (
        await fetch(`${ctx.baseUrl}/v1/auth/magic-link`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "nope" }),
        })
      ).status,
    ).toBe(400);
  });

  it("members can be added and removed; a member sees the shared project", async () => {
    const owner = await signIn("owner@example.com");
    const added = await fetch(`${ctx.baseUrl}/v1/members`, {
      method: "POST",
      headers: { cookie: owner, "content-type": "application/json" },
      body: JSON.stringify({ email: "teammate@example.com" }),
    });
    expect(added.status).toBe(201);
    const members = (await added.json()) as Array<{ id: string; email: string; role: string }>;
    expect(members.map((m) => m.email).sort()).toEqual(["owner@example.com", "teammate@example.com"]);

    const mate = await signIn("teammate@example.com");
    const mateSession = (await (
      await fetch(`${ctx.baseUrl}/v1/auth/session`, { headers: { cookie: mate } })
    ).json()) as { projects: Array<{ organizationName: string }> };
    expect(mateSession.projects.some((p) => p.organizationName === "owner's workspace")).toBe(true);

    const self = members.find((m) => m.email === "owner@example.com")!;
    expect(
      (await fetch(`${ctx.baseUrl}/v1/members/${self.id}`, { method: "DELETE", headers: { cookie: owner } }))
        .status,
    ).toBe(400);
    const other = members.find((m) => m.email === "teammate@example.com")!;
    expect(
      (await fetch(`${ctx.baseUrl}/v1/members/${other.id}`, { method: "DELETE", headers: { cookie: owner } }))
        .status,
    ).toBe(204);

    // x-overturn-project selects a project the user belongs to; a foreign one is refused
    const foreign = await fetch(`${ctx.baseUrl}/v1/runs`, {
      headers: { cookie: owner, "x-overturn-project": ctx.projectId },
    });
    expect(foreign.status).toBe(401);
  });
});
