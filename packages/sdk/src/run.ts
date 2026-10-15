import type { RunUpsert, StepKind, StepUpsert, Usage } from "@overturn/shared";
import { v7 as uuidv7 } from "uuid";
import { runStorage } from "./context.js";

export interface StartRunOptions {
  agent: string;
  version?: string;
  input?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
  externalId?: string;
  /** Override the run id (UUID v7). */
  id?: string;
}

export interface StepInput {
  kind: StepKind;
  name: string;
  input?: unknown;
  output?: unknown;
  model?: string | null;
  provider?: string | null;
  params?: Record<string, unknown>;
  usage?: Usage;
  costUsd?: number | null;
  latencyMs?: number | null;
  error?: string | null;
  sideEffect?: boolean;
  fingerprint?: string | null;
  startedAt?: Date;
  endedAt?: Date | null;
  parentStepId?: string | null;
  id?: string;
}

export interface RunSink {
  emitRun(run: RunUpsert): void;
  emitStep(step: StepUpsert): void;
}

export class Run {
  readonly id: string;
  readonly agent: string;
  readonly version: string | undefined;
  readonly startedAt: Date;
  private seq = 0;
  private ended = false;
  private readonly tags: string[];
  private readonly metadata: Record<string, unknown> | undefined;
  private readonly externalId: string | undefined;
  private readonly input: unknown;

  constructor(
    private readonly sink: RunSink,
    opts: StartRunOptions,
  ) {
    this.id = opts.id ?? uuidv7();
    this.agent = opts.agent;
    this.version = opts.version;
    this.tags = opts.tags ?? [];
    this.metadata = opts.metadata;
    this.externalId = opts.externalId;
    this.input = opts.input;
    this.startedAt = new Date();
    this.sink.emitRun({
      id: this.id,
      agent: this.agent,
      agentVersion: this.version ?? null,
      externalId: this.externalId ?? null,
      status: "running",
      input: this.input,
      tags: this.tags,
      metadata: this.metadata as RunUpsert["metadata"],
      startedAt: this.startedAt.toISOString(),
    });
  }

  /** Runs fn with this run as the ambient run for every wrapped client and tool. */
  context<T>(fn: () => Promise<T>): Promise<T>;
  context<T>(fn: () => T): T;
  context<T>(fn: () => T | Promise<T>): T | Promise<T> {
    return runStorage.run({ run: this, parentStepId: null }, fn);
  }

  nextSeq(): number {
    return this.seq++;
  }

  /** Records one step. Returns its id so children can reference it. */
  step(s: StepInput): string {
    const id = s.id ?? uuidv7();
    const startedAt = s.startedAt ?? new Date();
    const parent =
      s.parentStepId !== undefined ? s.parentStepId : (runStorage.getStore()?.parentStepId ?? null);
    this.sink.emitStep({
      id,
      runId: this.id,
      parentStepId: parent,
      seq: this.nextSeq(),
      kind: s.kind,
      name: s.name,
      input: s.input,
      output: s.output,
      model: s.model ?? null,
      provider: s.provider ?? null,
      params: s.params as StepUpsert["params"],
      usage: s.usage,
      costUsd: s.costUsd ?? null,
      latencyMs: s.latencyMs ?? null,
      error: s.error ?? null,
      sideEffect: s.sideEffect ?? false,
      fingerprint: s.fingerprint ?? null,
      startedAt: startedAt.toISOString(),
      endedAt: s.endedAt === undefined ? new Date().toISOString() : (s.endedAt?.toISOString() ?? null),
    });
    return id;
  }

  /** Marks the run completed (or failed when `error` is given). Idempotent. */
  end(result: { output?: unknown; error?: string } = {}): void {
    if (this.ended) return;
    this.ended = true;
    this.sink.emitRun({
      id: this.id,
      agent: this.agent,
      agentVersion: this.version ?? null,
      status: result.error ? "failed" : "completed",
      output: result.output,
      error: result.error ?? null,
      startedAt: this.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
    });
  }

  get isEnded(): boolean {
    return this.ended;
  }
}
