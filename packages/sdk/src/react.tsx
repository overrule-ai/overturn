import type { CorrectionKind } from "@overturn-ai/shared";
import { type CSSProperties, type ReactNode, useState } from "react";

/**
 * Drop-in correction control for your own product. Posts to a route served by
 * `ov.correctionHandler()`; no Overturn key in the browser.
 *
 * ```tsx
 * <CorrectButton endpoint="/api/overturn/correct" runId={run.id} original={run.output} />
 * ```
 */
export interface CorrectButtonProps {
  /** Route mounted with `ov.correctionHandler()`. */
  endpoint: string;
  runId: string;
  /** Model step to correct; omitted = the run's final answer. */
  stepId?: string | null;
  /** The agent's answer, prefilled when the human picks Edit. */
  original?: unknown;
  /** Which kinds to offer; default all four. */
  kinds?: CorrectionKind[];
  /** Extra headers for the request (CSRF token, etc.). */
  headers?: Record<string, string>;
  onDone?: (result: unknown) => void;
  onError?: (error: Error) => void;
  /** Trigger label; default "Correct". */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const LABELS: Record<CorrectionKind, { label: string; help: string }> = {
  approve: { label: "Approve", help: "The agent was right." },
  edit: { label: "Edit", help: "Here is the right answer." },
  reject: { label: "Reject", help: "Wrong; say why." },
  escalate: { label: "Escalate", help: "A human should have taken over." },
};

const s = {
  panel: {
    display: "grid",
    gap: 8,
    padding: 12,
    border: "1px solid #d4d4d8",
    borderRadius: 8,
    background: "#fff",
    color: "#18181b",
    font: "14px/1.4 system-ui, sans-serif",
    maxWidth: 480,
  } as CSSProperties,
  row: { display: "flex", flexWrap: "wrap", gap: 6 } as CSSProperties,
  kind: (active: boolean): CSSProperties => ({
    padding: "6px 10px",
    border: `1px solid ${active ? "#18181b" : "#d4d4d8"}`,
    borderRadius: 6,
    background: active ? "#f4f4f5" : "#fff",
    cursor: "pointer",
    font: "inherit",
  }),
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: 8,
    border: "1px solid #d4d4d8",
    borderRadius: 6,
    font: "inherit",
  } as CSSProperties,
  mono: { fontFamily: "ui-monospace, monospace", fontSize: 12, minHeight: 96 } as CSSProperties,
  primary: {
    padding: "6px 12px",
    border: "1px solid #18181b",
    borderRadius: 6,
    background: "#18181b",
    color: "#fff",
    cursor: "pointer",
    font: "inherit",
  } as CSSProperties,
  ghost: {
    padding: "6px 12px",
    border: "1px solid #d4d4d8",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    font: "inherit",
  } as CSSProperties,
  help: { fontSize: 12, color: "#71717a" } as CSSProperties,
  error: { fontSize: 12, color: "#b91c1c" } as CSSProperties,
};

export function CorrectButton(props: CorrectButtonProps) {
  const kinds = props.kinds ?? (["approve", "edit", "reject", "escalate"] as CorrectionKind[]);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CorrectionKind>(kinds[0] ?? "approve");
  const [text, setText] = useState(() =>
    typeof props.original === "string" ? props.original : JSON.stringify(props.original ?? null, null, 2),
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      let correctedOutput: unknown;
      if (kind === "edit") {
        const t = text.trim();
        if (t.startsWith("{") || t.startsWith("[")) {
          try {
            correctedOutput = JSON.parse(t);
          } catch (e) {
            throw new Error(`Corrected output is not valid JSON: ${(e as Error).message}`);
          }
        } else correctedOutput = t;
      }
      const res = await fetch(props.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(props.headers ?? {}) },
        body: JSON.stringify({
          runId: props.runId,
          stepId: props.stepId ?? null,
          kind,
          correctedOutput,
          note: note || null,
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      setDone(true);
      setOpen(false);
      props.onDone?.(body);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err.message);
      props.onError?.(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <span className={props.className} style={{ ...s.help, ...props.style }} data-overturn="done">
        Correction recorded · {LABELS[kind].label.toLowerCase()}
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className={props.className}
        style={{ ...s.ghost, ...props.style }}
        onClick={() => setOpen(true)}
        data-overturn="trigger"
      >
        {props.children ?? "Correct"}
      </button>
    );
  }

  return (
    <div className={props.className} style={{ ...s.panel, ...props.style }} data-overturn="panel">
      <fieldset style={{ ...s.row, border: 0, padding: 0, margin: 0 }} aria-label="Correction kind">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            style={s.kind(kind === k)}
            onClick={() => setKind(k)}
            title={LABELS[k].help}
          >
            {LABELS[k].label}
          </button>
        ))}
      </fieldset>
      <div style={s.help}>{LABELS[kind].help}</div>
      {kind === "edit" && (
        <textarea
          aria-label="Corrected output"
          style={{ ...s.input, ...s.mono }}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <textarea
        aria-label="Note"
        placeholder={
          kind === "reject" || kind === "escalate" ? "Why? (used as the judge rubric)" : "Why? (optional)"
        }
        style={s.input}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <div style={s.error}>{error}</div>}
      <div style={{ ...s.row, justifyContent: "flex-end" }}>
        <button type="button" style={s.ghost} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button type="button" style={s.primary} onClick={submit} disabled={busy} data-overturn="submit">
          {busy ? "Saving…" : `Save ${LABELS[kind].label.toLowerCase()}`}
        </button>
      </div>
    </div>
  );
}
