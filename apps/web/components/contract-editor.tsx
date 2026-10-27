"use client";

import type { Contract, ContractRule } from "@overturn-ai/shared";
import { describeRule } from "@overturn-ai/shared";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";

const MAX = 8;

/**
 * The outcome contract: one or two hard rules a reviewer attaches while they still have the
 * context. Deliberately sparse — a case with eight assertions is one nobody maintains.
 */
export function ContractEditor({
  value,
  onChange,
  tools,
  compact = false,
}: {
  value: Contract;
  onChange: (c: Contract) => void;
  /** Tool names seen in the run, offered as choices; free text is always allowed. */
  tools: string[];
  compact?: boolean;
}) {
  const [type, setType] = useState<ContractRule["type"]>("tool_called");
  const [tool, setTool] = useState(tools[0] ?? "");
  const [count, setCount] = useState<"once" | "at_least_once" | "never">("never");
  const [text, setText] = useState("");
  const [negate, setNegate] = useState(false);
  const [first, setFirst] = useState(tools[0] ?? "");
  const [second, setSecond] = useState(tools[1] ?? tools[0] ?? "");

  const add = () => {
    let rule: ContractRule | null = null;
    if (type === "tool_called" && tool.trim()) rule = { type, tool: tool.trim(), count };
    if (type === "answer" && text.trim())
      rule = { type, contains: text.trim(), negate, caseSensitive: false };
    if (type === "tool_order" && first.trim() && second.trim() && first !== second)
      rule = { type, first: first.trim(), second: second.trim() };
    if (!rule || value.length >= MAX) return;
    onChange([...value, rule]);
    setText("");
  };

  const toolInput = (v: string, set: (s: string) => void, testid: string) =>
    tools.length > 0 ? (
      <NativeSelect
        className="h-8 text-xs"
        value={v}
        onChange={(e) => set(e.target.value)}
        data-testid={testid}
      >
        {!tools.includes(v) && v && <option value={v}>{v}</option>}
        {tools.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </NativeSelect>
    ) : (
      <input
        className="flex h-8 rounded-md border px-2 font-mono text-xs"
        placeholder="tool name"
        value={v}
        onChange={(e) => set(e.target.value)}
        data-testid={testid}
      />
    );

  return (
    <div className="space-y-2" data-testid="contract-editor">
      {value.length > 0 && (
        <ul className="space-y-1">
          {value.map((r, i) => (
            <li
              key={describeRule(r)}
              className="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs"
            >
              <span className="flex-1 font-mono">{describeRule(r)}</span>
              <button
                type="button"
                aria-label="Remove rule"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onChange(value.filter((_, k) => k !== i))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length < MAX && (
        <div className={compact ? "flex flex-wrap items-center gap-2" : "flex flex-wrap items-center gap-2"}>
          <NativeSelect
            className="h-8 text-xs"
            value={type}
            onChange={(e) => setType(e.target.value as ContractRule["type"])}
            data-testid="contract-type"
          >
            <option value="tool_called">Tool</option>
            <option value="answer">Answer</option>
            <option value="tool_order">Order</option>
          </NativeSelect>
          {type === "tool_called" && (
            <>
              <NativeSelect
                className="h-8 text-xs"
                value={count}
                onChange={(e) => setCount(e.target.value as typeof count)}
                data-testid="contract-count"
              >
                <option value="never">never call</option>
                <option value="once">call exactly once</option>
                <option value="at_least_once">call at least once</option>
              </NativeSelect>
              {toolInput(tool, setTool, "contract-tool")}
            </>
          )}
          {type === "answer" && (
            <>
              <NativeSelect
                className="h-8 text-xs"
                value={negate ? "not" : "contains"}
                onChange={(e) => setNegate(e.target.value === "not")}
              >
                <option value="contains">must contain</option>
                <option value="not">must not contain</option>
              </NativeSelect>
              <input
                className="flex h-8 min-w-[160px] flex-1 rounded-md border px-2 text-xs"
                placeholder='e.g. "P0" or "refund"'
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                data-testid="contract-text"
              />
            </>
          )}
          {type === "tool_order" && (
            <>
              {toolInput(first, setFirst, "contract-first")}
              <span className="text-xs text-muted-foreground">before</span>
              {toolInput(second, setSecond, "contract-second")}
            </>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={add}
            data-testid="contract-add"
          >
            <Plus className="h-3.5 w-3.5" /> Add rule
          </Button>
        </div>
      )}
    </div>
  );
}
