import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  type Case,
  type CaseFilter,
  estimateCostUsd,
  hashJSON,
  type JudgeVerdict,
  parseJsonText,
  priceFor,
  type ReplayCreate,
  type ReplayEstimate,
  type ReplayJob,
  type ReplayReport,
  type ReplayResult,
  type ReplayResultsPost,
  type ReplaySummary,
  type ReportRow,
  type ScorerContext,
  score,
  type Verdict,
} from "@overturn/shared";
import { embed, generateText } from "ai";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { CasesService } from "../cases/cases.service";
import { APP_CONFIG, type AppConfig } from "../config";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import {
  cases,
  corrections,
  type ReplayJobRow,
  type ReplayResultRow,
  replayJobs,
  replayResults,
  responseCache,
} from "../db/schema";
import { fakeEmbedding, ModelRegistry, PROVIDER_CONCURRENCY, parseModel } from "../models/registry";
import { parseSettings } from "../projects/projects.controller";
import { callModel } from "./model-call";
import { PromptsService } from "./prompts.service";

const CACHE_TTL_MS = 24 * 3_600_000;
const EST_OUTPUT_TOKENS = 200;

export function serializeJob(j: ReplayJobRow): ReplayJob {
  return {
    id: j.id,
    projectId: j.projectId,
    targetModel: j.targetModel,
    targetPromptVersion: j.targetPromptVersion,
    mode: j.mode,
    caseFilter: j.caseFilter,
    status: j.status,
    summary: (j.summary ?? null) as ReplaySummary | null,
    estimatedCostUsd: j.estimatedCostUsd,
    maxCostUsd: j.maxCostUsd,
    costUsd: j.costUsd,
    caseCount: j.caseCount,
    completedCount: j.completedCount,
    error: j.error,
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
    createdAt: j.createdAt.toISOString(),
  };
}

export function serializeResult(r: ReplayResultRow): ReplayResult {
  return {
    id: r.id,
    jobId: r.jobId,
    caseId: r.caseId,
    output: r.output,
    score: r.score,
    passed: r.passed,
    verdict: r.verdict,
    reason: r.reason,
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
    diff: r.diff,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Verdict rules (brief, Replay engine). `unchanged` is reserved for job-vs-job comparison. */
export function verdictFor(c: Pick<Case, "kind">, passed: boolean, baselinePassed: boolean | null): Verdict {
  if (baselinePassed !== null) {
    if (c.kind === "approve" && baselinePassed && !passed) return "regression";
    if (c.kind !== "approve" && !baselinePassed && passed) return "fixed";
  }
  return passed ? "pass" : "fail";
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string; isRetryable?: boolean };
  const status = e.statusCode ?? e.status;
  if (e.isRetryable) return true;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return /rate limit|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(e.message ?? "");
}

@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);
  readonly registry: ModelRegistry;
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly cancelled = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly casesService: CasesService,
    private readonly prompts: PromptsService,
  ) {
    this.registry = new ModelRegistry(config);
  }

  // ---------- estimate ----------

  async estimate(projectId: string, model: string, filter: Partial<CaseFilter>): Promise<ReplayEstimate> {
    const list = await this.casesService.findAll(projectId, { status: "active", ...filter });
    return this.estimateFor(model, list);
  }

  estimateFor(model: string, list: Case[]): ReplayEstimate {
    const price = priceFor(model);
    let inputTokens = 0;
    let outputTokens = 0;
    for (const c of list) {
      inputTokens += Math.ceil(JSON.stringify(c.frozenInput).length / 4);
      outputTokens += Math.max(
        EST_OUTPUT_TOKENS,
        Math.ceil(JSON.stringify(c.originalOutput ?? "").length / 4),
      );
    }
    const cost = price ? (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000 : null;
    return {
      cases: list.length,
      estimatedCostUsd: cost,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
      priced: price !== null,
    };
  }

  // ---------- jobs ----------

  async create(
    projectId: string,
    input: ReplayCreate,
  ): Promise<{ job: ReplayJob; estimate: ReplayEstimate; caseIds: string[] }> {
    const { provider } = parseModel(input.model);
    if (!this.registry.isConfigured(provider) && input.mode === "step") {
      throw new BadRequestException(
        `Provider "${provider}" is not configured on this server (missing API key)`,
      );
    }
    if (input.promptVersion) await this.prompts.resolve(projectId, input.promptVersion); // validates
    const filter: CaseFilter = { status: "active", ...input.filter };
    const list = await this.casesService.findAll(projectId, filter);
    if (list.length === 0) throw new BadRequestException("No active cases match the filter");
    const estimate = this.estimateFor(input.model, list);
    const [row] = await this.db
      .insert(replayJobs)
      .values({
        id: uuidv7(),
        projectId,
        targetModel: input.model,
        targetPromptVersion: input.promptVersion ?? null,
        mode: input.mode,
        caseFilter: { ...filter, ids: list.map((c) => c.id) },
        status: "pending",
        estimatedCostUsd: estimate.estimatedCostUsd,
        maxCostUsd: input.maxCostUsd ?? null,
        caseCount: list.length,
      })
      .returning();
    return { job: serializeJob(row!), estimate, caseIds: list.map((c) => c.id) };
  }

  async get(projectId: string, id: string): Promise<ReplayJob> {
    const [row] = await this.db
      .select()
      .from(replayJobs)
      .where(and(eq(replayJobs.projectId, projectId), eq(replayJobs.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException(`Replay ${id} not found`);
    return serializeJob(row);
  }

  async list(projectId: string, q: { limit: number; status?: ReplayJob["status"] }): Promise<ReplayJob[]> {
    const where = [eq(replayJobs.projectId, projectId)];
    if (q.status) where.push(eq(replayJobs.status, q.status));
    const rows = await this.db
      .select()
      .from(replayJobs)
      .where(and(...where))
      .orderBy(desc(replayJobs.createdAt))
      .limit(q.limit);
    return rows.map(serializeJob);
  }

  async cancel(projectId: string, id: string): Promise<ReplayJob> {
    const job = await this.get(projectId, id);
    if (job.status === "completed" || job.status === "failed") return job;
    this.cancelled.add(id);
    await this.db
      .update(replayJobs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(replayJobs.id, id));
    return this.get(projectId, id);
  }

  async results(projectId: string, jobId: string): Promise<ReplayResult[]> {
    await this.get(projectId, jobId);
    const rows = await this.db.select().from(replayResults).where(eq(replayResults.jobId, jobId));
    return rows.map(serializeResult);
  }

  // ---------- baseline ----------

  /** Latest completed job for the model (and prompt) the case was recorded with, else null (recorded outputs are the baseline). */
  async baselineJob(
    projectId: string,
    recordedModel: string | null,
    excludeJobId: string,
  ): Promise<ReplayJobRow | null> {
    if (!recordedModel) return null;
    const candidates = [
      recordedModel,
      `openai/${recordedModel}`,
      `fake/${recordedModel}`,
      `anthropic/${recordedModel}`,
    ];
    const [row] = await this.db
      .select()
      .from(replayJobs)
      .where(
        and(
          eq(replayJobs.projectId, projectId),
          eq(replayJobs.status, "completed"),
          inArray(replayJobs.targetModel, candidates),
          sql`${replayJobs.id} <> ${excludeJobId}`,
          sql`${replayJobs.targetPromptVersion} is null`,
        ),
      )
      .orderBy(desc(replayJobs.createdAt))
      .limit(1);
    return row ?? null;
  }

  // ---------- scoring context ----------

  scorerContext(
    projectId: string,
    settings: ReturnType<typeof parseSettings>,
    charge: (usd: number) => void,
  ): ScorerContext {
    const judgeModelId = settings.judgeModel;
    const embeddingModelId = settings.embeddingModel;
    const judgeProvider = parseModel(judgeModelId).provider;
    const embedProvider = parseModel(embeddingModelId).provider;
    const ctx: ScorerContext = {};
    if (this.registry.isConfigured(judgeProvider)) {
      ctx.judge = async (prompt: string): Promise<JudgeVerdict> => {
        const cached = await this.cached(judgeModelId, { judge: prompt });
        if (cached) return cached.output as JudgeVerdict;
        const model = this.registry.languageModel(judgeModelId);
        const res = await this.withRetry(judgeProvider, () =>
          generateText({
            model,
            temperature: 0,
            seed: 42,
            maxRetries: 0,
            messages: [{ role: "user", content: prompt }],
          }),
        );
        const parsed = parseJsonText(res.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        const verdict: JudgeVerdict =
          parsed && typeof parsed === "object" && "pass" in parsed
            ? {
                pass: Boolean((parsed as { pass: unknown }).pass),
                reason: String((parsed as { reason?: unknown }).reason ?? ""),
              }
            : {
                pass: /\bpass\b/i.test(res.text) && !/\bfail\b/i.test(res.text),
                reason: res.text.slice(0, 300),
              };
        const cost =
          estimateCostUsd(judgeModelId, {
            inputTokens: res.usage.inputTokens,
            outputTokens: res.usage.outputTokens,
          }) ?? 0;
        charge(cost);
        await this.cache(judgeModelId, { judge: prompt }, verdict, cost);
        return verdict;
      };
    }
    if (this.registry.isConfigured(embedProvider)) {
      ctx.embed = async (text: string): Promise<number[]> => {
        const cached = await this.cached(embeddingModelId, { embed: text });
        if (cached) return cached.output as number[];
        const model = this.registry.embeddingModel(embeddingModelId);
        let vector: number[];
        let cost = 0;
        if (!model) vector = fakeEmbedding(text);
        else {
          const res = await this.withRetry(embedProvider, () => embed({ model, value: text, maxRetries: 0 }));
          vector = res.embedding;
          cost = estimateCostUsd(embeddingModelId, { inputTokens: res.usage.tokens }) ?? 0;
        }
        charge(cost);
        await this.cache(embeddingModelId, { embed: text }, vector, cost);
        return vector;
      };
    }
    return ctx;
  }

  // ---------- cache + retry ----------

  private cacheKey(model: string, input: unknown): string {
    return `${model}:${hashJSON(input)}`;
  }

  async cached(model: string, input: unknown): Promise<{ output: unknown; costUsd: number | null } | null> {
    const [row] = await this.db
      .select()
      .from(responseCache)
      .where(eq(responseCache.key, this.cacheKey(model, input)))
      .limit(1);
    if (!row || row.expiresAt.getTime() < Date.now()) return null;
    return { output: row.output, costUsd: row.costUsd };
  }

  async cache(
    model: string,
    input: unknown,
    output: unknown,
    costUsd: number | null,
    usage?: unknown,
  ): Promise<void> {
    await this.db
      .insert(responseCache)
      .values({
        key: this.cacheKey(model, input),
        model,
        output: output as object,
        usage: usage ?? null,
        costUsd,
        expiresAt: new Date(Date.now() + CACHE_TTL_MS),
      })
      .onConflictDoUpdate({
        target: responseCache.key,
        set: { output: output as object, costUsd, expiresAt: new Date(Date.now() + CACHE_TTL_MS) },
      });
  }

  async purgeExpiredCache(): Promise<number> {
    const rows = await this.db
      .delete(responseCache)
      .where(lt(responseCache.expiresAt, new Date()))
      .returning({ key: responseCache.key });
    return rows.length;
  }

  private semaphore(provider: string): Semaphore {
    let s = this.semaphores.get(provider);
    if (!s) {
      s = new Semaphore(PROVIDER_CONCURRENCY[provider] ?? 4);
      this.semaphores.set(provider, s);
    }
    return s;
  }

  async withRetry<T>(provider: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
    return this.semaphore(provider).run(async () => {
      for (let i = 0; ; i++) {
        try {
          return await fn();
        } catch (err) {
          if (i >= attempts - 1 || !isRetryable(err)) throw err;
          const backoff = Math.min(1000 * 2 ** i, 30_000) * (0.5 + Math.random());
          this.logger.warn(
            `${provider} call failed (attempt ${i + 1}): ${err instanceof Error ? err.message : String(err)}; retrying in ${Math.round(backoff)}ms`,
          );
          await sleep(backoff);
        }
      }
    });
  }

  // ---------- running (step mode) ----------

  /** Executes a step-mode job: called by the pg-boss worker, or directly in tests. */
  async runJob(jobId: string): Promise<ReplayJob> {
    const [job] = await this.db.select().from(replayJobs).where(eq(replayJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException(`Replay ${jobId} not found`);
    if (job.status !== "pending") return serializeJob(job);
    if (job.mode !== "step")
      throw new BadRequestException("Trajectory jobs run through the CLI; the server only runs step mode");
    const projectId = job.projectId;
    const startedAt = new Date();
    await this.db.update(replayJobs).set({ status: "running", startedAt }).where(eq(replayJobs.id, jobId));

    const [projectRow] = await this.db.execute(sql`select settings from projects where id = ${projectId}`);
    const settings = parseSettings((projectRow as { settings?: unknown } | undefined)?.settings);
    const filter = job.caseFilter as CaseFilter;
    const list = await this.casesService.findAll(projectId, filter);
    const { provider } = parseModel(job.targetModel);
    const systemPrompt = job.targetPromptVersion
      ? (await this.prompts.resolve(projectId, job.targetPromptVersion)).template
      : null;
    const baseline = await this.baselineJob(projectId, list[0]?.recordedModel ?? null, jobId);
    const baselineResults = baseline
      ? await this.resultsByCase(baseline.id)
      : new Map<string, ReplayResultRow>();

    let spent = 0;
    let stoppedByCostCap = false;
    const charge = (usd: number) => {
      spent += usd;
    };
    const ctx = this.scorerContext(projectId, settings, charge);
    const model = this.registry.languageModel(job.targetModel);
    let completed = 0;

    const runOne = async (c: Case): Promise<void> => {
      if (this.cancelled.has(jobId) || stoppedByCostCap) return;
      if (job.maxCostUsd != null && spent >= job.maxCostUsd) {
        stoppedByCostCap = true;
        return;
      }
      const t0 = Date.now();
      let output: unknown = null;
      let error: string | null = null;
      let costUsd = 0;
      try {
        const cacheInput = { frozen: c.frozenInput, systemPrompt };
        const hit = await this.cached(job.targetModel, cacheInput);
        if (hit) {
          output = hit.output;
          costUsd = 0;
        } else {
          const res = await this.withRetry(provider, () => callModel(model, c.frozenInput, { systemPrompt }));
          output = res.answer;
          costUsd = estimateCostUsd(job.targetModel, res.usage) ?? 0;
          await this.cache(job.targetModel, cacheInput, res.answer, costUsd, res.usage);
        }
        charge(costUsd);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      let scored: { score: number | null; passed: boolean | null; reason: string | null } = {
        score: null,
        passed: null,
        reason: null,
      };
      let verdict: Verdict = "error";
      if (!error) {
        try {
          const r = await score(
            {
              scorer: c.scorer,
              config: c.scorerConfig,
              expected: c.expected,
              actual: output,
              kind: c.kind,
              note: c.note,
            },
            ctx,
          );
          const base = baselineResults.get(c.id);
          const baselinePassed = base ? base.passed : await this.recordedBaselinePassed(c, ctx);
          scored = r;
          verdict = verdictFor(c, r.passed, baselinePassed);
        } catch (err) {
          error = `scoring failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      await this.storeResult(projectId, jobId, c, {
        output,
        score: scored.score,
        passed: scored.passed,
        verdict,
        reason: scored.reason,
        latencyMs: Date.now() - t0,
        costUsd,
        error,
        diff:
          output === null
            ? null
            : {
                expected: c.expected,
                baseline: baselineResults.get(c.id)?.output ?? c.originalOutput,
                target: output,
              },
      });
      completed++;
      await this.db
        .update(replayJobs)
        .set({ completedCount: completed, costUsd: spent })
        .where(eq(replayJobs.id, jobId));
    };

    try {
      // worker pool: the cost cap is checked before each case starts, so a cap stops new work promptly
      const queue = [...list];
      const workers = Array.from(
        { length: Math.min(PROVIDER_CONCURRENCY[provider] ?? 4, queue.length) },
        async () => {
          for (let c = queue.shift(); c; c = queue.shift()) await runOne(c);
        },
      );
      await Promise.all(workers);
      const cancelledNow = this.cancelled.has(jobId);
      this.cancelled.delete(jobId);
      const summary = await this.summarize(
        jobId,
        list.length,
        spent,
        Date.now() - startedAt.getTime(),
        baseline,
        list[0]?.recordedModel ?? null,
        stoppedByCostCap,
      );
      await this.db
        .update(replayJobs)
        .set({
          status: cancelledNow ? "cancelled" : "completed",
          summary,
          costUsd: spent,
          completedCount: summary.completed,
          finishedAt: new Date(),
        })
        .where(eq(replayJobs.id, jobId));
    } catch (err) {
      await this.db
        .update(replayJobs)
        .set({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
        })
        .where(eq(replayJobs.id, jobId));
    }
    return this.get(projectId, jobId);
  }

  /** With no baseline job, the recorded original output is the baseline: score it the same way. */
  private async recordedBaselinePassed(c: Case, ctx: ScorerContext): Promise<boolean | null> {
    if (c.originalOutput === null) return null;
    try {
      const r = await score(
        {
          scorer: c.scorer,
          config: c.scorerConfig,
          expected: c.expected,
          actual: c.originalOutput,
          kind: c.kind,
          note: c.note,
        },
        ctx,
      );
      return r.passed;
    } catch {
      return null;
    }
  }

  private async resultsByCase(jobId: string): Promise<Map<string, ReplayResultRow>> {
    const rows = await this.db.select().from(replayResults).where(eq(replayResults.jobId, jobId));
    return new Map(rows.map((r) => [r.caseId, r]));
  }

  private async storeResult(
    projectId: string,
    jobId: string,
    c: Case,
    r: Omit<typeof replayResults.$inferInsert, "id" | "projectId" | "jobId" | "caseId">,
  ): Promise<void> {
    await this.db
      .insert(replayResults)
      .values({ id: uuidv7(), projectId, jobId, caseId: c.id, ...r })
      .onConflictDoUpdate({ target: [replayResults.jobId, replayResults.caseId], set: { ...r } });
    await this.db.update(cases).set({ lastVerdict: r.verdict }).where(eq(cases.id, c.id));
  }

  private async summarize(
    jobId: string,
    caseCount: number,
    costUsd: number,
    durationMs: number,
    baseline: ReplayJobRow | null,
    recordedModel: string | null,
    stoppedByCostCap: boolean,
  ): Promise<ReplaySummary> {
    const rows = await this.db.select().from(replayResults).where(eq(replayResults.jobId, jobId));
    const verdicts: Partial<Record<Verdict, number>> = {};
    let passed = 0;
    let failed = 0;
    for (const r of rows) {
      verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      if (r.passed === true) passed++;
      else if (r.passed === false) failed++;
    }
    const scored = passed + failed;
    return {
      cases: caseCount,
      completed: rows.length,
      passed,
      failed,
      passRate: scored === 0 ? 0 : passed / scored,
      verdicts: verdicts as Record<Verdict, number>,
      costUsd,
      durationMs,
      baseline: baseline
        ? { kind: "job", jobId: baseline.id, model: baseline.targetModel }
        : { kind: "recorded", jobId: null, model: recordedModel },
      stoppedByCostCap,
    };
  }

  // ---------- trajectory results (posted by the CLI, M5) ----------

  async postResults(projectId: string, jobId: string, body: ReplayResultsPost): Promise<ReplayJob> {
    const [job] = await this.db
      .select()
      .from(replayJobs)
      .where(and(eq(replayJobs.projectId, projectId), eq(replayJobs.id, jobId)))
      .limit(1);
    if (!job) throw new NotFoundException(`Replay ${jobId} not found`);
    if (job.status === "completed" || job.status === "cancelled")
      throw new BadRequestException(`Replay ${jobId} is ${job.status}`);
    if (job.status === "pending")
      await this.db
        .update(replayJobs)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(replayJobs.id, jobId));
    const [projectRow] = await this.db.execute(sql`select settings from projects where id = ${projectId}`);
    const settings = parseSettings((projectRow as { settings?: unknown } | undefined)?.settings);
    let spent = job.costUsd;
    const ctx = this.scorerContext(projectId, settings, (usd) => {
      spent += usd;
    });
    const ids = body.results.map((r) => r.caseId);
    const list = await this.casesService.findAll(projectId, { status: "active", ids });
    const byId = new Map(list.map((c) => [c.id, c]));
    const baseline = await this.baselineJob(projectId, list[0]?.recordedModel ?? null, jobId);
    const baselineResults = baseline
      ? await this.resultsByCase(baseline.id)
      : new Map<string, ReplayResultRow>();

    for (const r of body.results) {
      const c = byId.get(r.caseId);
      if (!c) continue;
      spent += r.costUsd ?? 0;
      let verdict: Verdict = "error";
      let scored: { score: number | null; passed: boolean | null; reason: string | null } = {
        score: null,
        passed: null,
        reason: null,
      };
      let error = r.error ?? null;
      if (r.unreplayable) {
        verdict = "unreplayable";
        scored.reason = `${r.unreplayable.reason === "refused" ? "side-effect tool refused" : "no recording for tool call"}: ${r.unreplayable.toolName}(${JSON.stringify(r.unreplayable.args)})`;
      } else if (!error) {
        try {
          const s = await score(
            {
              scorer: c.scorer,
              config: c.scorerConfig,
              expected: c.expected,
              actual: r.output ?? null,
              kind: c.kind,
              note: c.note,
            },
            ctx,
          );
          const base = baselineResults.get(c.id);
          const baselinePassed = base ? base.passed : await this.recordedBaselinePassed(c, ctx);
          scored = s;
          verdict = verdictFor(c, s.passed, baselinePassed);
        } catch (err) {
          error = `scoring failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      await this.storeResult(projectId, jobId, c, {
        output: r.output ?? null,
        score: scored.score,
        passed: scored.passed,
        verdict,
        reason: scored.reason,
        latencyMs: r.latencyMs ?? null,
        costUsd: r.costUsd ?? null,
        error,
        diff: {
          expected: c.expected,
          baseline: baselineResults.get(c.id)?.output ?? c.originalOutput,
          target: r.output ?? null,
          steps: r.steps ?? null,
          unreplayable: r.unreplayable ?? null,
        },
      });
    }
    const [{ n }] = (await this.db.execute(
      sql`select count(*)::int as n from replay_results where job_id = ${jobId}`,
    )) as unknown as [{ n: number }];
    await this.db
      .update(replayJobs)
      .set({ completedCount: n, costUsd: spent })
      .where(eq(replayJobs.id, jobId));
    if (body.finish) {
      const durationMs = job.startedAt ? Date.now() - job.startedAt.getTime() : null;
      const summary = await this.summarize(
        jobId,
        job.caseCount,
        spent,
        durationMs ?? 0,
        baseline,
        list[0]?.recordedModel ?? null,
        false,
      );
      await this.db
        .update(replayJobs)
        .set({
          status: body.error ? "failed" : "completed",
          error: body.error ?? null,
          summary,
          finishedAt: new Date(),
        })
        .where(eq(replayJobs.id, jobId));
    }
    return this.get(projectId, jobId);
  }

  // ---------- report ----------

  async report(projectId: string, jobId: string): Promise<ReplayReport> {
    const job = await this.get(projectId, jobId);
    const rows = await this.db
      .select({ r: replayResults, c: cases, note: corrections.note, actor: corrections.actor })
      .from(replayResults)
      .innerJoin(cases, eq(cases.id, replayResults.caseId))
      .innerJoin(corrections, eq(corrections.id, cases.correctionId))
      .where(eq(replayResults.jobId, jobId));
    const toRow = ({ r, c, note, actor }: (typeof rows)[number]): ReportRow => ({
      caseId: c.id,
      title: c.title,
      kind: c.kind,
      agent: c.agent,
      runId: c.runId,
      scorer: c.scorer as ReportRow["scorer"],
      verdict: r.verdict,
      passed: r.passed,
      score: r.score,
      reason: r.reason,
      baselineOutput: (r.diff as { baseline?: unknown } | null)?.baseline ?? c.originalOutput,
      targetOutput: r.output,
      expected: c.expected,
      note,
      actor,
      error: r.error,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
    });
    const all = rows.map(toRow).sort((a, b) => a.title.localeCompare(b.title));
    const summary: ReplaySummary = job.summary ?? {
      cases: job.caseCount,
      completed: all.length,
      passed: all.filter((x) => x.passed === true).length,
      failed: all.filter((x) => x.passed === false).length,
      passRate: 0,
      verdicts: {} as Record<Verdict, number>,
      costUsd: job.costUsd,
      durationMs: null,
      baseline: null,
      stoppedByCostCap: false,
    };
    return {
      job,
      summary,
      regressions: all.filter((x) => x.verdict === "regression"),
      stillWrong: all.filter((x) => x.verdict === "fail"),
      fixed: all.filter((x) => x.verdict === "fixed"),
      passed: all.filter((x) => x.verdict === "pass"),
      unreplayable: all.filter((x) => x.verdict === "unreplayable"),
      errors: all.filter((x) => x.verdict === "error"),
    };
  }
}
