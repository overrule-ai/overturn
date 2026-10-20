// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CorrectButton } from "./react.js";

const runId = "01a14c81-adc1-749a-a32c-3d5c8017bd53";
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const q = <T extends Element>(sel: string): T => {
  const el = host.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
function setValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const buttonByText = (text: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === text) ??
  (() => {
    throw new Error(`no button ${text}`);
  })();

describe("<CorrectButton>", () => {
  it("opens, posts an edit with the parsed JSON and a note to the endpoint, then shows done", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ correction: { id: "x" }, case: { id: "c1" } }), { status: 200 }),
      );
    const onDone = vi.fn();
    act(() => {
      root.render(
        <CorrectButton
          endpoint="/api/overturn/correct"
          runId={runId}
          original={{ priority: "P2", team: "billing" }}
          headers={{ "x-csrf": "t" }}
          onDone={onDone}
        />,
      );
    });
    expect(q("[data-overturn=trigger]").textContent).toBe("Correct");
    click(q("[data-overturn=trigger]"));
    expect(q("[data-overturn=panel]")).toBeTruthy();
    click(buttonByText("Edit"));
    const editor = q<HTMLTextAreaElement>("textarea[aria-label='Corrected output']");
    expect(editor.value).toContain('"priority": "P2"');
    setValue(editor, JSON.stringify({ priority: "P0", team: "billing" }));
    setValue(q<HTMLTextAreaElement>("textarea[aria-label='Note']"), "outage keyword");
    await act(async () => {
      q("[data-overturn=submit]").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/overturn/correct");
    expect((init.headers as Record<string, string>)["x-csrf"]).toBe("t");
    expect(JSON.parse(init.body as string)).toEqual({
      runId,
      stepId: null,
      kind: "edit",
      correctedOutput: { priority: "P0", team: "billing" },
      note: "outage keyword",
    });
    expect(onDone).toHaveBeenCalledWith({ correction: { id: "x" }, case: { id: "c1" } });
    expect(q("[data-overturn=done]").textContent).toContain("edit");
  });

  it("shows the server's error and stays open", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "run not found" }), { status: 502 }),
    );
    act(() => {
      root.render(<CorrectButton endpoint="/c" runId={runId} kinds={["approve", "reject"]} />);
    });
    click(q("[data-overturn=trigger]"));
    expect(Array.from(host.querySelectorAll("[aria-pressed]")).map((b) => b.textContent)).toEqual([
      "Approve",
      "Reject",
    ]);
    await act(async () => {
      q("[data-overturn=submit]").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.textContent).toContain("run not found");
    expect(q("[data-overturn=panel]")).toBeTruthy();
  });
});
