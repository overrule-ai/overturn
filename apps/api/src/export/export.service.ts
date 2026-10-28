import { Inject, Injectable } from "@nestjs/common";
import type { Case, CaseFilter, ExportFormat, ExportQuery, ExportStats } from "@overturn-ai/shared";
import { isToolDecision } from "@overturn-ai/shared";
import type { ModelMessage } from "ai";
import { CasesService } from "../cases/cases.service";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { buildMessages } from "../replay/model-call";

/** OpenAI chat-format message, the lingua franca of hosted fine-tuning APIs (Together, OpenAI, HF trl). */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface SftRow {
  messages: ChatMessage[];
  /** Tool schemas the model could call, when the frozen input had them. */
  tools?: unknown;
  /** Provenance: never trained on, useful for auditing a dataset. */
  meta: { caseId: string; kind: string; agent: string; runId: string };
}

export interface DpoRow {
  messages: ChatMessage[];
  chosen: ChatMessage;
  rejected: ChatMessage;
  tools?: unknown;
  meta: { caseId: string; kind: string; agent: string; runId: string };
}

/** AI SDK ModelMessage[] (what replay sends) -> OpenAI chat messages. */
export function toChatMessages(messages: ModelMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") out.push({ role: "system", content: String(m.content) });
    else if (m.role === "user")
      out.push({
        role: "user",
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.map((p) => (p.type === "text" ? p.text : JSON.stringify(p))).join(""),
      });
    else if (m.role === "assistant") {
      if (typeof m.content === "string") out.push({ role: "assistant", content: m.content });
      else {
        const text = m.content
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join("");
        const calls = m.content
          .filter((p) => p.type === "tool-call")
          .map((p) => {
            const tc = p as { toolCallId: string; toolName: string; input: unknown };
            return {
              id: tc.toolCallId,
              type: "function" as const,
              function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) },
            };
          });
        out.push({
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
      }
    } else if (m.role === "tool") {
      for (const p of m.content) {
        const r = p as { toolCallId: string; output?: { value?: unknown } };
        out.push({
          role: "tool",
          tool_call_id: r.toolCallId,
          content:
            typeof r.output?.value === "string" ? r.output.value : JSON.stringify(r.output?.value ?? null),
        });
      }
    }
  }
  return out;
}

/** The answer a case holds (string, object, or a tool decision) as the assistant turn to train on. */
export function answerMessage(answer: unknown): ChatMessage | null {
  if (answer === null || answer === undefined) return null;
  if (isToolDecision(answer)) {
    const calls = answer.tool_calls.map((tc, i) => ({
      id: `call_${i + 1}`,
      type: "function" as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }));
    if (calls.length === 0) return null;
    return { role: "assistant", content: null, tool_calls: calls };
  }
  if (typeof answer === "string") return answer.trim() ? { role: "assistant", content: answer } : null;
  return { role: "assistant", content: JSON.stringify(answer) };
}

@Injectable()
export class ExportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly cases: CasesService,
  ) {}

  private filterOf(q: ExportQuery): CaseFilter {
    return {
      status: "active",
      agent: q.agent,
      tag: q.tag,
      set: q.set,
      since: q.since,
    };
  }

  /**
   * SFT: every case whose human-approved answer is known becomes prompt -> answer.
   *   approve  -> the agent's answer (it was right)
   *   edit     -> the corrected answer
   *   reject / escalate -> skipped: there is no right answer to imitate, only a wrong one
   * DPO: edit cases become (chosen = corrected, rejected = original); approve cases have no
   *   rejected sample and reject cases have no chosen one, so both are skipped.
   */
  rowFor(c: Case, format: ExportFormat, includeApproved: boolean): SftRow | DpoRow | null {
    const messages = toChatMessages(buildMessages(c.frozenInput));
    // the frozen conversation ends where the model was asked to answer; never train on an assistant tail
    while (messages.length && messages[messages.length - 1]!.role === "assistant") messages.pop();
    if (messages.length === 0) return null;
    const tools = c.frozenInput.tools;
    const meta = { caseId: c.id, kind: c.kind, agent: c.agent, runId: c.runId };
    if (format === "sft") {
      if (c.kind === "reject" || c.kind === "escalate") return null;
      if (c.kind === "approve" && !includeApproved) return null;
      const target = answerMessage(c.kind === "approve" ? (c.originalOutput ?? c.expected) : c.expected);
      if (!target) return null;
      return { messages: [...messages, target], ...(tools ? { tools } : {}), meta };
    }
    if (c.kind !== "edit") return null;
    const chosen = answerMessage(c.expected);
    const rejected = answerMessage(c.originalOutput);
    if (!chosen || !rejected) return null;
    if (JSON.stringify(chosen) === JSON.stringify(rejected)) return null;
    return { messages, chosen, rejected, ...(tools ? { tools } : {}), meta };
  }

  async *rows(projectId: string, q: ExportQuery): AsyncGenerator<SftRow | DpoRow> {
    const list = await this.cases.findAll(projectId, this.filterOf(q));
    let n = 0;
    for (const c of list) {
      if (n >= q.limit) return;
      const row = this.rowFor(c, q.format, q.includeApproved);
      if (!row) continue;
      n++;
      yield row;
    }
  }

  async stats(projectId: string, q: ExportQuery): Promise<ExportStats> {
    const list = await this.cases.findAll(projectId, this.filterOf(q));
    const byKind: Record<string, number> = {};
    let rows = 0;
    let skipped = 0;
    let chars = 0;
    for (const c of list) {
      const row = this.rowFor(c, q.format, q.includeApproved);
      if (!row || rows >= q.limit) {
        skipped++;
        continue;
      }
      rows++;
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      chars += JSON.stringify(row).length;
    }
    return { format: q.format, rows, skipped, byKind, approxTokens: Math.round(chars / 4) };
  }
}
