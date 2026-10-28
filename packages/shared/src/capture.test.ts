import { describe, expect, it } from "vitest";
import {
  captureAnswerValue,
  diffCaptureAnswers,
  normalizeCaptureText,
  renderCaptureContext,
} from "./capture";

describe("capture", () => {
  it("a re-wrapped reply is not a change", () => {
    const draft = { text: "Hi Dana,\n\nYour claim is covered.  We will\nsend the check." };
    const sent = { text: "Hi Dana,\r\n\r\nYour claim is covered. We will send the check.\n" };
    expect(normalizeCaptureText(draft.text)).not.toBe(normalizeCaptureText(sent.text));
    const same = { text: "Hi Dana,\n\nYour claim is covered. We will send the check." };
    expect(diffCaptureAnswers(sent, same)).toEqual({ changed: false, textChanged: false, changedFields: [] });
  });

  it("a changed decision field is a change even when the text is the same", () => {
    const d = diffCaptureAnswers(
      { text: "Approved.", fields: { status: "approved", reserve: 1200 } },
      { text: "Approved.", fields: { status: "approved", reserve: 1800 } },
    );
    expect(d).toEqual({ changed: true, textChanged: false, changedFields: ["reserve"] });
  });

  it("a field added by the expert counts as changed", () => {
    const d = diffCaptureAnswers({ text: "x" }, { text: "x", fields: { denial_reason: "late notice" } });
    expect(d.changedFields).toEqual(["denial_reason"]);
  });

  it("answer value is the text alone, or the fields with the text under reply", () => {
    expect(captureAnswerValue({ text: " hello " })).toBe("hello");
    expect(captureAnswerValue({ text: "hello", fields: { status: "denied" } })).toEqual({
      status: "denied",
      reply: "hello",
    });
    expect(captureAnswerValue({ text: "hello", fields: {} })).toBe("hello");
  });

  it("renders the thread oldest first with subject and fields", () => {
    const s = renderCaptureContext(
      [
        { role: "customer", author: "dana@x.com", content: "My roof leaked.", at: "2026-10-01T10:00:00Z" },
        { role: "note", content: "Policy HO-3, no prior claims." },
      ],
      { subject: "Claim 48213", fields: { status: "open" } },
    );
    expect(s).toContain("Subject: Claim 48213");
    expect(s).toContain("Fields to decide: status");
    expect(s.indexOf("Customer (dana@x.com)")).toBeLessThan(s.indexOf("Internal note:"));
  });
});
