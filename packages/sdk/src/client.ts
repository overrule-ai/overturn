import type { RunUpsert, StepUpsert } from "@overturn/shared";
import { currentRun } from "./context.js";
import { type OpenAILike, wrapOpenAI } from "./openai.js";
import { ReplayState, type ToolRecordings } from "./replay.js";
import { Run, type RunSink, type StartRunOptions, type StepInput } from "./run.js";
import { makeTool, type ToolImpl, type ToolOptions, type WrappedTool } from "./tool.js";
import { Transport, type TransportOptions } from "./transport.js";

export interface OverturnOptions {
  apiKey?: string;
  /** Defaults to OVERTURN_BASE_URL or https://api.overturn.dev */
  baseUrl?: string;
  /** Called on every step before it is sent. Return null to drop it. */
  redact?: (step: StepUpsert) => StepUpsert | null;
  /** Disable recording entirely (e.g. in unit tests). */
  enabled?: boolean;
  debug?: boolean;
  transport?: Partial<Omit<TransportOptions, "apiKey" | "baseUrl">>;
  onError?: TransportOptions["onError"];
}

export class Overturn implements RunSink {
  readonly transport: Transport | null;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Non-null while in replay mode. */
  replay: ReplayState | null = null;
  private readonly redact: OverturnOptions["redact"];
  private readonly debug: boolean;

  constructor(opts: OverturnOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    this.apiKey = opts.apiKey ?? env.OVERTURN_API_KEY ?? "";
    this.baseUrl = opts.baseUrl ?? env.OVERTURN_BASE_URL ?? "https://api.overturn.dev";
    this.debug = opts.debug ?? env.OVERTURN_DEBUG === "1";
    this.redact = opts.redact;
    const enabled = opts.enabled ?? true;
    if (!enabled) {
      this.transport = null;
    } else {
      if (!this.apiKey && this.debug) console.warn("[overturn] no API key set; nothing will be recorded");
      this.transport = this.apiKey
        ? new Transport({
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            debug: this.debug,
            onError: opts.onError,
            ...opts.transport,
          })
        : null;
    }
  }

  // ---- RunSink ----
  emitRun(run: RunUpsert): void {
    this.transport?.enqueueRun(run);
  }
  emitStep(step: StepUpsert): void {
    if (!this.transport) return;
    const out = this.redact ? this.redact(step) : step;
    if (out) this.transport.enqueueStep(out);
  }

  // ---- public API ----
  startRun(opts: StartRunOptions): Run {
    return new Run(this, opts);
  }

  /** The ambient run inside run.context(), if any. */
  currentRun(): Run | undefined {
    return currentRun();
  }

  /** Records a step on the ambient run. No-op outside run.context(). */
  step(s: StepInput): string | undefined {
    return currentRun()?.step(s);
  }

  tool<A, R>(name: string, impl: ToolImpl<A, R>, options: ToolOptions = {}): WrappedTool<A, R> {
    return makeTool(this, name, impl, options);
  }

  wrapOpenAI<T extends OpenAILike>(client: T): T {
    return wrapOpenAI(client);
  }

  /** Puts every ov.tool() into replay: answered from recordings, never executed. */
  replayMode(recordings: ToolRecordings, options: { allowSideEffects?: boolean } = {}): ReplayState {
    this.replay = new ReplayState(recordings, options);
    return this.replay;
  }

  exitReplayMode(): void {
    this.replay = null;
  }

  /** Sends everything queued. Call before the process exits. */
  async flush(): Promise<void> {
    await this.transport?.flush();
  }

  async shutdown(): Promise<void> {
    await this.transport?.close();
  }
}
