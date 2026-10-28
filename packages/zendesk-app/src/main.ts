import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  QUICK_REASONS,
  settingsFrom,
  statusLine,
  type TicketSnapshot,
} from "./capture";

/** The slice of the Zendesk App Framework client this app uses. */
interface ZafClient {
  init?: () => ZafClient;
  on(event: string, handler: (data?: unknown) => unknown): void;
  get<T = Record<string, unknown>>(paths: string | string[]): Promise<T>;
  invoke(name: string, ...args: unknown[]): Promise<unknown>;
  metadata<T = { settings: Record<string, unknown> }>(): Promise<T>;
  context<T = Record<string, unknown>>(): Promise<T>;
  request<T = unknown>(opts: Record<string, unknown>): Promise<T>;
}
declare global {
  interface Window {
    ZAFClient: { init(): ZafClient };
  }
}

interface ZafComment {
  id?: number;
  value: string;
  type: string;
  author?: { name?: string; email?: string; role?: string };
  createdAt?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

async function main(): Promise<void> {
  const client = window.ZAFClient.init();
  const meta = await client.metadata();
  const settings: AppSettings = settingsFrom(meta.settings ?? {});
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const root = document.getElementById("app")!;
  const status = el("div", { class: "status" }, "Waiting for a draft");
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Why did you change it? One line.",
  }) as HTMLTextAreaElement;
  const quick = el("div", { class: "quick" });
  for (const q of QUICK_REASONS) {
    const b = el("button", { type: "button", class: "chip" }, q);
    b.addEventListener("click", () => {
      reason.value = q;
      reason.focus();
    });
    quick.appendChild(b);
  }
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  root.append(status, reason, quick, mark, note);
  void client.invoke("resize", { width: "100%", height: "260px" });

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  const ticketId = (await client.get<{ "ticket.id": number }>("ticket.id"))["ticket.id"];

  // A drafting agent that recorded its run with the SDK: the draft is its output.
  try {
    const found = await client.request<{ items: Array<{ id: string; output: unknown; agent: string }> }>({
      url: `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`zd:${ticketId}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
      type: "GET",
      headers: { Authorization: "Bearer {{setting.overturn_api_key}}" },
      secure: true,
    });
    const run = found.items[0];
    if (run && typeof run.output === "string" && run.output.trim()) {
      detector.set({ text: run.output, origin: "recorded", runId: run.id, at: Date.now() });
    }
  } catch {
    // no recorded draft; the composer is watched instead
  }

  const composer = await client.get<{ "ticket.comment.text": string }>("ticket.comment.text");
  detector.onComposer(composer["ticket.comment.text"] ?? "");
  client.on("ticket.comment.text.changed", (text) => {
    if (detector.onComposer(typeof text === "string" ? text : "")) render();
  });
  mark.addEventListener("click", async () => {
    const now = await client.get<{ "ticket.comment.text": string }>("ticket.comment.text");
    const text = now["ticket.comment.text"] ?? "";
    if (!text.trim()) return;
    detector.set({ text, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });
  render();

  const readFields = async (): Promise<Record<string, unknown>> => {
    if (settings.decisionFields.length === 0) return {};
    const paths = settings.decisionFields.map((f) => `ticket.customField:${f.id}`);
    const values = await client.get<Record<string, unknown>>(paths);
    return Object.fromEntries(settings.decisionFields.map((f, i) => [f.label, values[paths[i]!] ?? null]));
  };
  const draftFields = await readFields();

  client.on("ticket.save", async () => {
    const draft: DraftState | null = detector.current();
    const data = await client.get<Record<string, unknown>>([
      "ticket.comment.text",
      "ticket.comment.type",
      "ticket.subject",
      "ticket.requester.email",
      "ticket.requester.name",
      "ticket.comments",
      "currentUser.email",
    ]);
    const comments = (data["ticket.comments"] as ZafComment[] | undefined) ?? [];
    const ticket: TicketSnapshot = {
      id: ticketId,
      subject: (data["ticket.subject"] as string | null) ?? null,
      requesterEmail: (data["ticket.requester.email"] as string | null) ?? null,
      requesterName: (data["ticket.requester.name"] as string | null) ?? null,
      comments: comments.map((c) => ({
        id: c.id,
        value: c.value,
        type: c.type,
        authorName: c.author?.name ?? null,
        authorEmail: c.author?.email ?? null,
        isAgent: c.author?.role !== undefined && c.author.role !== "end-user",
        createdAt: c.createdAt ?? null,
      })),
      fields: await readFields(),
      url: `${location.ancestorOrigins?.[0] ?? ""}/agent/tickets/${ticketId}`,
    };
    const decision = decideOnSend({
      ticket,
      draft,
      draftFields,
      send: {
        text: (data["ticket.comment.text"] as string) ?? "",
        type: (data["ticket.comment.type"] as string) ?? "publicReply",
        fields: ticket.fields,
      },
      reason: reason.value,
      actor: (data["currentUser.email"] as string | null) ?? null,
      settings,
    });
    if (decision.action === "skip") return true;
    if (decision.action === "need-reason") {
      reason.focus();
      // Rejecting with a string blocks the submit and shows the message to the agent.
      throw `Overturn: add one line on why you changed the ${decision.changedFields.length ? decision.changedFields.join(", ") : "reply"} (or ask your admin to turn off "require a reason").`;
    }
    try {
      const r = await client.request<CaptureResult>({
        url: `${settings.baseUrl}/v1/capture`,
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify(decision.body),
        headers: { Authorization: "Bearer {{setting.overturn_api_key}}" },
        secure: true,
      });
      lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
      note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
      reason.value = "";
      detector.set(null);
      render();
    } catch (e) {
      // Never block the agent's work on our failure; say so in the panel.
      note.textContent = `Overturn could not save this correction (${(e as { status?: number }).status ?? "network"}).`;
    }
    return true;
  });
}

void main();
