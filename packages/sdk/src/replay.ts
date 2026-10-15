/**
 * Replay mode: tools are answered from a case's recordings and never execute.
 * Two guarantees, each covered by a test in client.test.ts:
 *  1. A tool call whose fingerprint has no recording throws UnreplayableError; the real tool is not called.
 *  2. A tool declared sideEffect: true is refused outright, even when a recording exists.
 *
 * Replay state is process-global (keyed on globalThis), so the CLI's trajectory runner
 * and the customer's own `new Overturn()` instances, even from separate copies of this
 * package, see the same mode.
 */
import type { StepUpsert } from "@overturn-ai/shared";

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

export class MaxStepsExceededError extends Error {
  constructor(public readonly maxSteps: number) {
    super(`Replay stopped: the agent exceeded maxSteps (${maxSteps})`);
    this.name = "MaxStepsExceededError";
  }
}

/** Normalized model call used in trajectory replay: the SDK sends the recorded-shape input, the server answers with the target model. */
export interface ReplayModelInput {
  provider: "openai" | "anthropic" | "ai";
  messages?: unknown;
  system?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  params?: Record<string, unknown>;
}

export interface ReplayModelOutput {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  modelId: string | null;
  costUsd: number | null;
}

export type ReplayModelCall = (input: ReplayModelInput) => Promise<ReplayModelOutput>;

export interface ReplayOptions {
  allowSideEffects?: boolean;
  /** Target model: when set, wrapped model clients call this instead of the real provider. */
  modelCall?: ReplayModelCall;
  /** Stop the trajectory after this many recorded steps (tool + model calls). */
  maxSteps?: number;
}

export class ReplayState {
  /** Tool calls the agent made during replay, in order; used for tool_choice scoring and unreplayable reports. */
  readonly calls: Array<{
    name: string;
    args: unknown;
    fingerprint: string;
    status: "answered" | "unseen" | "refused";
  }> = [];
  /** Every step recorded while in replay mode (nothing is sent to the API in replay). */
  readonly steps: StepUpsert[] = [];
  readonly modelCall: ReplayModelCall | undefined;
  readonly maxSteps: number;

  constructor(
    private readonly recordings: ToolRecordings,
    private readonly options: ReplayOptions = {},
  ) {
    this.modelCall = options.modelCall;
    this.maxSteps = options.maxSteps ?? 50;
  }

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

  /** Collects a step; throws once the trajectory exceeds maxSteps. */
  record(step: StepUpsert): void {
    this.steps.push(step);
    if (this.steps.length > this.maxSteps) throw new MaxStepsExceededError(this.maxSteps);
  }
}

const KEY = Symbol.for("overturn.replay.state");

export function getGlobalReplay(): ReplayState | null {
  return ((globalThis as Record<symbol, unknown>)[KEY] as ReplayState | undefined) ?? null;
}

export function setGlobalReplay(state: ReplayState | null): void {
  (globalThis as Record<symbol, unknown>)[KEY] = state ?? undefined;
}
