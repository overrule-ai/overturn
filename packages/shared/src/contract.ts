import type { Contract, ContractRule } from "./schemas.js";

/** What a contract is evaluated against: the tool calls the agent made, in order, and its final answer. */
export interface ContractSubject {
  toolCalls: string[];
  output: unknown;
}

/** The answer as text: a string as-is, otherwise the JSON of the whole value (so field values are searchable). */
export function answerText(output: unknown): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const k of ["text", "content", "reply", "answer", "output"])
      if (typeof o[k] === "string") return o[k] as string;
  }
  return JSON.stringify(output);
}

export function describeRule(r: ContractRule): string {
  switch (r.type) {
    case "tool_called":
      return r.count === "never"
        ? `never call ${r.tool}`
        : r.count === "once"
          ? `call ${r.tool} exactly once`
          : `call ${r.tool} at least once`;
    case "answer":
      return `${r.negate ? "answer must not contain" : "answer must contain"} ${JSON.stringify(r.contains)}`;
    case "tool_order":
      return `call ${r.first} before ${r.second}`;
  }
}

/** Violations, in words, or an empty array when every rule holds. */
export function evaluateContract(contract: Contract, subject: ContractSubject): string[] {
  const out: string[] = [];
  const calls = subject.toolCalls;
  for (const r of contract) {
    switch (r.type) {
      case "tool_called": {
        const n = calls.filter((c) => c === r.tool).length;
        if (r.count === "never" && n > 0) out.push(`${describeRule(r)} — called ${n}×`);
        else if (r.count === "once" && n !== 1) out.push(`${describeRule(r)} — called ${n}×`);
        else if (r.count === "at_least_once" && n === 0) out.push(`${describeRule(r)} — not called`);
        break;
      }
      case "answer": {
        // search the whole answer: a string as-is, a structured answer as its JSON, so field values count
        const text =
          typeof subject.output === "string" ? subject.output : JSON.stringify(subject.output ?? "");
        const has = r.caseSensitive
          ? text.includes(r.contains)
          : text.toLowerCase().includes(r.contains.toLowerCase());
        if (has === r.negate) out.push(`${describeRule(r)} — ${r.negate ? "it does" : "it does not"}`);
        break;
      }
      case "tool_order": {
        const a = calls.indexOf(r.first);
        const b = calls.indexOf(r.second);
        if (a === -1 || b === -1) {
          if (b !== -1) out.push(`${describeRule(r)} — ${r.first} was never called`);
        } else if (a > b) out.push(`${describeRule(r)} — ${r.second} came first`);
        break;
      }
    }
  }
  return out;
}

/** Tool names from a step-mode output (a tool decision) or a trajectory's steps. */
export function toolCallsOf(output: unknown, steps?: unknown[] | null): string[] {
  const names: string[] = [];
  if (Array.isArray(steps))
    for (const s of steps) {
      const st = s as { kind?: string; name?: string } | null;
      if (st && st.kind === "tool_call" && typeof st.name === "string") names.push(st.name);
    }
  if (names.length > 0) return names;
  const o = output as { tool_calls?: { name?: string }[] } | null;
  if (o && Array.isArray(o.tool_calls))
    for (const tc of o.tool_calls) if (tc && typeof tc.name === "string") names.push(tc.name);
  return names;
}
