import { INGEST_VERSION, type IngestPayload, type RunUpsert, type StepUpsert } from "@overturn/shared";

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  /** Flush at most this often while items are queued. Default 1000ms. */
  flushIntervalMs?: number;
  /** Max runs+steps per request. Default 100. */
  maxBatchSize?: number;
  /** Drop oldest items beyond this many queued. Default 10000. */
  maxQueueSize?: number;
  /** Retries per batch before dropping it. Default 5. */
  maxRetries?: number;
  /** Base backoff. Default 500ms, doubling, capped at 30s. */
  backoffMs?: number;
  fetch?: typeof fetch;
  onError?: (error: Error, context: { dropped: boolean; attempt: number }) => void;
  debug?: boolean;
  /** Test hook: disables the timer so flushes only happen on demand. */
  disableTimer?: boolean;
}

type Item = { kind: "run"; data: RunUpsert } | { kind: "step"; data: StepUpsert };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * Batched, asynchronous, retrying ingest. Never throws into the caller's agent:
 * failures are reported through onError and the batch is retried with backoff,
 * then dropped. Items for the same run/step id are merged so a run start and
 * its end in one batch become one upsert.
 */
export class Transport {
  private queue: Item[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private closed = false;
  private readonly opts: Required<Omit<TransportOptions, "onError" | "fetch">> &
    Pick<TransportOptions, "onError" | "fetch">;
  /** Visible for tests. */
  public stats = { sent: 0, batches: 0, retries: 0, dropped: 0 };

  constructor(options: TransportOptions) {
    this.opts = {
      flushIntervalMs: 1000,
      maxBatchSize: 100,
      maxQueueSize: 10_000,
      maxRetries: 5,
      backoffMs: 500,
      debug: false,
      disableTimer: false,
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
    };
  }

  enqueueRun(run: RunUpsert): void {
    this.push({ kind: "run", data: run });
  }

  enqueueStep(step: StepUpsert): void {
    this.push({ kind: "step", data: step });
  }

  get pending(): number {
    return this.queue.length;
  }

  private push(item: Item): void {
    if (this.closed) return;
    this.queue.push(item);
    if (this.queue.length > this.opts.maxQueueSize) {
      const overflow = this.queue.length - this.opts.maxQueueSize;
      this.queue.splice(0, overflow);
      this.stats.dropped += overflow;
      this.opts.onError?.(new TransportError(`queue overflow, dropped ${overflow} items`, undefined, false), {
        dropped: true,
        attempt: 0,
      });
    }
    if (this.queue.length >= this.opts.maxBatchSize) {
      void this.flush();
    } else {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.timer || this.opts.disableTimer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushIntervalMs);
    // Do not keep the process alive just for a pending flush.
    const t = this.timer as { unref?: () => void };
    t.unref?.();
  }

  /** Sends everything queued. Resolves when the queue is empty or batches were dropped. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      await this.inflight;
      if (this.queue.length === 0) return;
    }
    this.inflight = this.drain().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.opts.maxBatchSize);
      await this.sendWithRetry(buildPayload(batch));
    }
  }

  private async sendWithRetry(payload: IngestPayload): Promise<void> {
    const count = payload.runs.length + payload.steps.length;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        await this.send(payload);
        this.stats.sent += count;
        this.stats.batches += 1;
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const retryable = !(error instanceof TransportError) || error.retryable;
        const last = attempt === this.opts.maxRetries || !retryable;
        this.opts.onError?.(error, { dropped: last, attempt });
        if (this.opts.debug)
          console.error(`[overturn] ingest attempt ${attempt + 1} failed: ${error.message}`);
        if (last) {
          this.stats.dropped += count;
          return;
        }
        this.stats.retries += 1;
        await sleep(Math.min(this.opts.backoffMs * 2 ** attempt, 30_000) * (0.5 + Math.random()));
      }
    }
  }

  private async send(payload: IngestPayload): Promise<void> {
    const f = this.opts.fetch ?? globalThis.fetch;
    const res = await f(`${this.opts.baseUrl}/v1/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        "user-agent": "overturn-sdk-js/0.1.0",
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) return;
    const text = await res.text().catch(() => "");
    // 4xx other than 408/429 will not get better with a retry
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new TransportError(`ingest failed: ${res.status} ${text.slice(0, 300)}`, res.status, retryable);
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}

export function buildPayload(items: Item[]): IngestPayload {
  const runs = new Map<string, RunUpsert>();
  const steps = new Map<string, StepUpsert>();
  for (const item of items) {
    if (item.kind === "run") {
      const prev = runs.get(item.data.id);
      runs.set(item.data.id, prev ? mergeDefined(prev, item.data) : item.data);
    } else {
      const prev = steps.get(item.data.id);
      steps.set(item.data.id, prev ? mergeDefined(prev, item.data) : item.data);
    }
  }
  return { v: INGEST_VERSION, runs: [...runs.values()], steps: [...steps.values()] };
}

function mergeDefined<T extends object>(base: T, next: T): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(next)) if (v !== undefined) out[k] = v;
  return out as T;
}
