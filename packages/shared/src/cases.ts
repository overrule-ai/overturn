import type { CorrectionKind, ScorerName } from "./schemas.js";

/**
 * The "answer" an llm_call step produced, in the shape humans correct:
 *  - tool calls -> { tool_calls: [{ name, args }] }
 *  - JSON text  -> the parsed object
 *  - plain text -> the string
 * Works for OpenAI chat (message.content / message.tool_calls), Anthropic
 * (content blocks), the AI SDK (content parts) and OTLP (gen_ai.output.messages).
 */
export function extractAnswer(stepOutput: unknown): unknown {
  if (stepOutput === null || stepOutput === undefined) return null;
  if (typeof stepOutput === "string") return parseJsonText(stepOutput);
  if (typeof stepOutput !== "object") return stepOutput;
  const o = stepOutput as Record<string, unknown>;

  // AI SDK: { content: [{type:'text',text}|{type:'tool-call',toolName,input}] }
  if (Array.isArray(o.content) && !("message" in o)) return fromParts(o.content as unknown[]);

  const message = (o.message ?? o) as Record<string, unknown>;
  // OpenAI chat: message.tool_calls / message.content
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return {
      tool_calls: (message.tool_calls as Array<Record<string, unknown>>).map((tc) => {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        return {
          name: (fn.name ?? tc.name) as string,
          args: parseJsonText((fn.arguments ?? tc.args ?? tc.input) as unknown),
        };
      }),
    };
  }
  if (Array.isArray(message.content)) return fromParts(message.content as unknown[]);
  if (typeof message.content === "string") return parseJsonText(message.content);
  if (message.content !== undefined && message.content !== null) return message.content;
  // OTLP output.messages may be a list of messages
  if (Array.isArray(o.messages)) return extractAnswer({ message: (o.messages as unknown[])[0] });
  return stepOutput;
}

function fromParts(parts: unknown[]): unknown {
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const text: string[] = [];
  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (p.type === "tool_use" || p.type === "tool-call" || p.type === "tool_call")
      toolCalls.push({
        name: (p.name ?? p.toolName) as string,
        args: parseJsonText(p.input ?? p.args ?? p.arguments),
      });
    else if (p.type === "text" && typeof p.text === "string") text.push(p.text);
  }
  if (toolCalls.length > 0) return { tool_calls: toolCalls };
  return parseJsonText(text.join(""));
}

export function parseJsonText(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

export function isToolDecision(v: unknown): v is { tool_calls: Array<{ name: string; args: unknown }> } {
  return typeof v === "object" && v !== null && Array.isArray((v as { tool_calls?: unknown }).tool_calls);
}

/** Expected value by correction kind (see the brief, Core flows / Auto-case). */
export function expectedFor(
  kind: CorrectionKind,
  originalAnswer: unknown,
  correctedOutput: unknown,
  note: string | null,
): unknown {
  switch (kind) {
    case "edit":
      return correctedOutput ?? null;
    case "approve":
      return originalAnswer ?? null;
    case "reject":
      return { not_equals: originalAnswer ?? null, rubric: note ?? null };
    case "escalate":
      return { should_escalate: true, rubric: note ?? null };
  }
}

/** Default scorer from the shape of `expected` (brief, Replay engine). */
export function defaultScorer(
  kind: CorrectionKind,
  expected: unknown,
  note: string | null,
): { scorer: ScorerName; config: Record<string, unknown> } {
  if (kind === "reject") return { scorer: "not_equals", config: note ? { judge: true } : {} };
  if (kind === "escalate") return { scorer: "should_escalate", config: note ? { judge: true } : {} };
  if (isToolDecision(expected)) return { scorer: "tool_choice", config: {} };
  if (expected !== null && typeof expected === "object") return { scorer: "json_match", config: {} };
  if (typeof expected === "string") {
    if (expected.length < 200) return { scorer: "equals", config: { fallback: "semantic", threshold: 0.85 } };
    return { scorer: "judge", config: {} };
  }
  return { scorer: "equals", config: {} };
}
