import type { CorrectionKind, CorrectionResult, RunUpsert, StepUpsert } from "@overturn-ai/shared";
import { aiMiddleware } from "./ai-sdk.js";
import { type AnthropicLike, wrapAnthropic } from "./anthropic.js";
import { OverturnApi } from "./api.js";
import { currentRun } from "./context.js";
import { type OpenAILike, wrapOpenAI } from "./openai.js";
import {
  getGlobalReplay,
  type ReplayOptions,
  ReplayState,
  setGlobalReplay,
  type ToolRecordings,
} from "./replay.js";
import { Run, type RunSink, type StartRunOptions, type StepInput } from "./run.js";
import { makeTool, type ToolImpl, type ToolOptions, type WrappedTool } from "./tool.js";
import { Transport, type TransportOptions } from "./transport.js";

export interface OverturnOptions {
  apiKey?: string;
  /** Defaults to OVERTURN_BASE_URL or https://api.overturn.run */
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
  /** Typed REST client (runs, cases, corrections, project). */
  readonly api: OverturnApi;
  /** Non-null while in replay mode (process-global, shared by every Overturn instance). */
  get replay(): ReplayState | null {
    return getGlobalReplay();
  }
  private readonly redact: OverturnOptions["redact"];
  private readonly debug: boolean;

  constructor(opts: OverturnOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    this.apiKey = opts.apiKey ?? env.OVERTURN_API_KEY ?? "";
    this.baseUrl = opts.baseUrl ?? env.OVERTURN_BASE_URL ?? "https://api.overturn.run";
    this.debug = opts.debug ?? env.OVERTURN_DEBUG === "1";
    this.redact = opts.redact;
    this.api = new OverturnApi({ apiKey: this.apiKey, baseUrl: this.baseUrl, fetch: opts.transport?.fetch });
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
    if (this.replay) return; // replay runs are never recorded as production runs
    this.transport?.enqueueRun(run);
  }
  emitStep(step: StepUpsert): void {
    const replay = this.replay;
    if (replay) {
      replay.record(step);
      return;
    }
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
    return wrapOpenAI(client, this);
  }

  wrapAnthropic<T extends AnthropicLike>(client: T): T {
    return wrapAnthropic(client, this);
  }

  /** Vercel AI SDK: `wrapLanguageModel({ model, middleware: ov.aiMiddleware() })`. */
  aiMiddleware() {
    return aiMiddleware();
  }

  /**
   * Records a human correction and freezes a regression case from it. Call this from
   * your own approve/edit UI. Sends immediately (not batched) and returns the case.
   */
  correct(input: {
    runId: string;
    stepId?: string | null;
    kind: CorrectionKind;
    correctedOutput?: unknown;
    note?: string | null;
    actor?: string | null;
  }): Promise<CorrectionResult> {
    return this.api.corrections.create({ ...input, source: "sdk" });
  }

  /** Puts every ov.tool() into replay: answered from recordings, never executed. */
  replayMode(recordings: ToolRecordings, options: ReplayOptions = {}): ReplayState {
    const state = new ReplayState(recordings, options);
    setGlobalReplay(state);
    return state;
  }

  exitReplayMode(): void {
    setGlobalReplay(null);
  }

  /** Sends everything queued. Call before the process exits. */
  async flush(): Promise<void> {
    await this.transport?.flush();
  }

  async shutdown(): Promise<void> {
    await this.transport?.close();
  }
}
