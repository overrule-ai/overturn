/**
 * Replay mode: tools are answered from a case's recordings and never execute.
 * Two guarantees, each covered by a test in replay.test.ts:
 *  1. A tool call whose fingerprint has no recording throws UnreplayableError; the real tool is not called.
 *  2. A tool declared sideEffect: true is refused outright, even when a recording exists.
 */

export interface ToolRecording {
  name: string;
  args: unknown;
  output: unknown;
}

export type ToolRecordings = Record<string, ToolRecording>;

export class UnreplayableError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly args: unknown,
    public readonly fingerprint: string,
  ) {
    super(
      `No recording for tool "${toolName}" with fingerprint ${fingerprint.slice(0, 12)}…; the real tool was not executed`,
    );
    this.name = "UnreplayableError";
  }
}

export class SideEffectRefusedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly args: unknown,
  ) {
    super(`Tool "${toolName}" is marked sideEffect: true and is refused in replay mode`);
    this.name = "SideEffectRefusedError";
  }
}

export class ReplayState {
  /** Tool calls the agent made during replay, in order; used for tool_choice scoring and unreplayable reports. */
  readonly calls: Array<{
    name: string;
    args: unknown;
    fingerprint: string;
    status: "answered" | "unseen" | "refused";
  }> = [];

  constructor(
    private readonly recordings: ToolRecordings,
    private readonly options: { allowSideEffects?: boolean } = {},
  ) {}

  answer(name: string, args: unknown, fingerprint: string, sideEffect: boolean): unknown {
    if (sideEffect && !this.options.allowSideEffects) {
      this.calls.push({ name, args, fingerprint, status: "refused" });
      throw new SideEffectRefusedError(name, args);
    }
    const rec = this.recordings[fingerprint];
    if (!rec) {
      this.calls.push({ name, args, fingerprint, status: "unseen" });
      throw new UnreplayableError(name, args, fingerprint);
    }
    this.calls.push({ name, args, fingerprint, status: "answered" });
    return rec.output;
  }
}
