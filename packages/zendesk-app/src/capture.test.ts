import { describe, expect, it } from "vitest";
import {
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  settingsFrom,
  statusLine,
  stripHtml,
  type TicketSnapshot,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const ticket: TicketSnapshot = {
  id: 48213,
  subject: "Roof leak after storm",
  requesterEmail: "dana@example.com",
  requesterName: "Dana",
  comments: [
    {
      id: 1,
      value: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      type: "publicReply",
      authorEmail: "dana@example.com",
      isAgent: false,
      createdAt: "2026-10-01T10:00:00Z",
    },
    { id: 2, value: "HO-3, no prior claims.", type: "internalNote", authorName: "Ray", isAgent: true },
  ],
  fields: {},
  url: "https://carrier.zendesk.com/agent/tickets/48213",
};

describe("settings", () => {
  it("parses the manifest parameters", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "true",
      decision_fields: "custom_field_1:status, custom_field_2:reserve,custom_field_3",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "custom_field_1", label: "status" },
      { id: "custom_field_2", label: "reserve" },
      { id: "custom_field_3", label: "custom_field_3" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });
  it("falls back to defaults", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);
  it("a reply-sized insert into an empty composer is the draft; typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 100; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();
    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    expect(d2.onComposer(long, 500)?.origin).toBe("inserted");
    expect(d2.onComposer(`${long} more`, 600)).toBeNull(); // only the first
  });
  it("a composer that already holds a reply on load is a preloaded draft", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("preloaded");
  });
  it("a paste after a pause while a short greeting was typed still counts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    d.onComposer("Hi Dana,", 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, 9000)?.origin).toBe("inserted");
  });
});

describe("context and html", () => {
  it("strips html and maps roles", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(ticket)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00Z",
      },
      { role: "note", author: "Ray", content: "HO-3, no prior claims.", at: null },
    ]);
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1 };
  const base = {
    ticket,
    draft,
    draftFields: {},
    reason: "",
    actor: "ray@carrier.com",
    settings: DEFAULT_SETTINGS,
  };

  it("skips without a draft, on internal notes, and on empty sends", () => {
    expect(
      decideOnSend({ ...base, draft: null, send: { text: "x", type: "publicReply", fields: {} } }),
    ).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnSend({ ...base, send: { text: "x", type: "internalNote", fields: {} } })).toEqual({
      action: "skip",
      why: "internal-note",
    });
    expect(decideOnSend({ ...base, send: { text: "<p></p>", type: "publicReply", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("sending the draft unchanged is an approve capture", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.externalId).toBe("zd:48213");
    expect(d.body.agent).toBe("claims-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:inserted", "public-reply"]);
    expect(d.body.context).toHaveLength(2);
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reason: "Storm SLA is 2 days",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason blocks a changed send until there is a reason", () => {
    const settings = { ...DEFAULT_SETTINGS, requireReason: true };
    const sent = draftText.replace("covered", "not covered");
    const blocked = decideOnSend({
      ...base,
      settings,
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });
    const ok = decideOnSend({
      ...base,
      settings,
      reason: "exclusion",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    const unchanged = decideOnSend({
      ...base,
      settings,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    expect(unchanged.action).toBe("capture");
  });

  it("decision fields ride along and a changed field is a change", () => {
    const settings = { ...DEFAULT_SETTINGS, decisionFields: [{ id: "custom_field_1", label: "status" }] };
    const d = decideOnSend({
      ...base,
      settings,
      draftFields: { status: "covered" },
      send: { text: draftText, type: "publicReply", fields: { status: "denied" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "covered" });
    expect(d.body.sent.fields).toEqual({ status: "denied" });
  });

  it("a recorded draft attaches to its run", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 1,
      },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
  });
});
