import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  type Case,
  type CaseFilter,
  estimateCostUsd,
  evaluateContract,
  type FrozenInput,
  hashJSON,
  type JudgeVerdict,
  parseJsonText,
  priceFor,
  type ReplayCreate,
  type ReplayEstimate,
  type ReplayJob,
  type ReplayMatrix,
  type ReplayModelCallRequest,
  type ReplayModelCallResponse,
  type ReplayReport,
  type ReplayResult,
  type ReplayResultsPost,
  type ReplaySummary,
  type ReportRow,
  type ScorecardRow,
  type ScorerContext,
  score,
  toolCallsOf,
  toolFingerprint,
  type Verdict,
} from "@overturn-ai/shared";
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
import { ExamplesService, inputTextOf } from "../examples/examples.service";
import { fakeEmbedding, ModelRegistry, PROVIDER_CONCURRENCY, parseModel } from "../models/registry";
import { parseSettings } from "../projects/settings";
import { buildMessages, callModel } from "./model-call";

/** The system prompt as recorded in a frozen input, if any. */
function systemPromptOf(frozen: FrozenInput): string | null {
  const m = buildMessages(frozen).find((x) => x.role === "system");
  return m ? String(m.content) : null;
}

import { PromptsService } from "./prompts.service";

const CACHE_TTL_MS = 24 * 3_600_000;
const EST_OUTPUT_TOKENS = 200;

export function serializeJob(j: ReplayJobRow): ReplayJob {
  return {
    id: j.id,
    projectId: j.projectId,
    targetModel: j.targetModel,
    targetPromptVersion: j.targetPromptVersion,
    options: { examples: Number((j.options as { examples?: number } | null)?.examples ?? 0) },
    groupId: j.groupId ?? null,
    startedBy: j.startedBy ?? null,
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
/**
 * The outcome contract runs after the scorer: a violated rule fails the case whatever the scorer
 * said, and the violations are spelled out in the reason. Returns the violations for the report.
 */
export function applyContract(
  c: Pick<Case, "contract">,
  scored: { score: number | null; passed: boolean | null; reason: string | null },
  subject: { output: unknown; steps?: unknown[] | null },
): string[] {
  if (!c.contract?.length) return [];
  const violations = evaluateContract(c.contract, {
    toolCalls: toolCallsOf(subject.output, subject.steps),
    output: subject.output,
  });
  if (violations.length === 0) return [];
  scored.passed = false;
  scored.score = 0;
  scored.reason = `contract: ${violations.join("; ")}${scored.reason ? ` (scorer: ${scored.reason})` : ""}`;
  return violations;
}

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
    private readonly examples: ExamplesService,
  ) {
    this.registry = new ModelRegistry(config);
  }

  /** The embedder examples need, or a clear error naming the keys that would provide one. */
  examplesContext(
    settings: { embeddingModel: string },
    ctx: ScorerContext,
  ): { embed: NonNullable<ScorerContext["embed"]>; model: string } | null {
    const model = this.registry.resolveEmbeddingModel(settings.embeddingModel);
    if (!model || !ctx.embed) return null; // lexical retrieval
    return { embed: ctx.embed, model };
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

  /**
   * Creates one job per target model. `job`/`estimate` describe the first model (the classic
   * single-model shape); `jobs` has all of them, sharing `groupId` when there is more than one.
   */
  async create(
    projectId: string,
    input: ReplayCreate,
    startedBy: string | null = null,
  ): Promise<{ job: ReplayJob; jobs: ReplayJob[]; estimate: ReplayEstimate; caseIds: string[] }> {
    const models = [input.model, ...(input.models ?? []).filter((m) => m !== input.model)];
    for (const model of models) {
      const { provider } = parseModel(model);
      if (!this.registry.isConfigured(provider) && input.mode === "step") {
        throw new BadRequestException(
          `Provider "${provider}" is not configured on this server (missing API key)`,
        );
      }
    }
    if (input.promptVersion) await this.prompts.resolve(projectId, input.promptVersion); // validates
    const filter: CaseFilter = { status: "active", ...input.filter };
    const list = await this.casesService.findAll(projectId, filter);
    if (list.length === 0) throw new BadRequestException("No active cases match the filter");
    const groupId = models.length > 1 ? uuidv7() : null;
    const jobs: ReplayJob[] = [];
    let estimate: ReplayEstimate | null = null;
    for (const model of models) {
      const est = this.estimateFor(model, list);
      estimate ??= est;
      const [row] = await this.db
        .insert(replayJobs)
        .values({
          id: uuidv7(),
          projectId,
          targetModel: model,
          targetPromptVersion: input.promptVersion ?? null,
          groupId,
          startedBy,
          mode: input.mode,
          caseFilter: { ...filter, ids: list.map((c) => c.id) },
          status: "pending",
          estimatedCostUsd: est.estimatedCostUsd,
          maxCostUsd: input.maxCostUsd ?? null,
          caseCount: list.length,
          options: { examples: input.examples ?? 0 },
        })
        .returning();
      jobs.push(serializeJob(row!));
    }
    return { job: jobs[0]!, jobs, estimate: estimate!, caseIds: list.map((c) => c.id) };
  }

  /** Case × model matrix for jobs created together. */
  async matrix(projectId: string, groupId: string): Promise<ReplayMatrix> {
    const jobRows = await this.db
      .select()
      .from(replayJobs)
      .where(and(eq(replayJobs.projectId, projectId), eq(replayJobs.groupId, groupId)))
      .orderBy(replayJobs.createdAt);
    if (jobRows.length === 0) throw new NotFoundException(`Replay group ${groupId} not found`);
    const jobs = jobRows.map(serializeJob);
    const ids = (jobRows[0]!.caseFilter as { ids?: string[] }).ids ?? [];
    const caseRows = ids.length
      ? await this.db
          .select({ id: cases.id, title: cases.title, kind: cases.kind, agent: cases.agent })
          .from(cases)
          .where(and(eq(cases.projectId, projectId), inArray(cases.id, ids)))
      : [];
    const results = await this.db
      .select()
      .from(replayResults)
      .where(
        inArray(
          replayResults.jobId,
          jobs.map((j) => j.id),
        ),
      );
    const byCaseJob = new Map<string, ReplayResultRow>();
    for (const r of results) byCaseJob.set(`${r.caseId}:${r.jobId}`, r);
    const rows = caseRows
      .map((c) => ({
        caseId: c.id,
        title: c.title,
        kind: c.kind,
        agent: c.agent,
        cells: Object.fromEntries(
          jobs.map((j) => {
            const r = byCaseJob.get(`${c.id}:${j.id}`);
            return [
              j.id,
              r
                ? { verdict: r.verdict, passed: r.passed, score: r.score, reason: r.reason }
                : { verdict: null, passed: null, score: null, reason: null },
            ];
          }),
        ),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return {
      groupId,
      jobs,
      cases: rows,
      scorecard: scorecardFor(jobs, caseRows.length ? await this.recordedModelFor(projectId, ids) : null),
    };
  }

  /** The model the (first of these) cases was recorded with: the incumbent in a scorecard. */
  private async recordedModelFor(projectId: string, ids: string[]): Promise<string | null> {
    const [row] = await this.db
      .select({ m: cases.recordedModel, p: cases.frozenInput })
      .from(cases)
      .where(and(eq(cases.projectId, projectId), inArray(cases.id, ids)))
      .limit(1);
    if (!row?.m) return null;
    const provider = (row.p as { provider?: string } | null)?.provider;
    return row.m.includes("/") ? row.m : `${provider ?? "openai"}/${row.m}`;
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
    const judgeModelId = this.registry.resolveJudgeModel(settings.judgeModel) ?? settings.judgeModel;
    if (judgeModelId !== settings.judgeModel) {
      this.logger.warn(`judge ${settings.judgeModel} has no key; using ${judgeModelId}`);
    }
    const embeddingModelId =
      this.registry.resolveEmbeddingModel(settings.embeddingModel) ?? settings.embeddingModel;
    const judgeProvider = parseModel(judgeModelId).provider;
    const embedProvider = parseModel(embeddingModelId).provider;
    const ctx: ScorerContext = {};
    if (this.registry.isConfigured(judgeProvider)) {
      ctx.judge = async (prompt: string): Promise<JudgeVerdict> => {
        const cached = await this.cached(judgeModelId, { judge: prompt });
        if (cached) return cached.output as JudgeVerdict;
        const model = this.registry.languageModel(judgeModelId);
        let res: Awaited<ReturnType<typeof generateText>>;
        try {
          res = await this.withRetry(judgeProvider, () =>
            generateText({
              model,
              temperature: 0,
              seed: 42,
              maxRetries: 0,
              messages: [{ role: "user", content: prompt }],
            }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `judge ${judgeModelId} failed (${msg}); check the ${judgeProvider} key on the server or set another judgeModel in project settings`,
          );
        }
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
    // corrections in the prompt: k nearest human-approved cases per case, leave-one-out
    const examplesK = Number((job.options as { examples?: number } | null)?.examples ?? 0);
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
        let prompt = systemPrompt;
        if (examplesK > 0) {
          const ex = await this.examples.forInput(
            projectId,
            { input: inputTextOf(c) || c.title, k: examplesK, excludeCaseId: c.id },
            this.examplesContext(settings, ctx),
          );
          const base = systemPrompt ?? systemPromptOf(c.frozenInput) ?? "";
          prompt = `${base}\n${ex.promptBlock}`;
        }
        const cacheInput = { frozen: c.frozenInput, systemPrompt: prompt };
        const hit = await this.cached(job.targetModel, cacheInput);
        if (hit) {
          output = hit.output;
          costUsd = 0;
        } else {
          const res = await this.withRetry(provider, () =>
            callModel(model, c.frozenInput, { systemPrompt: prompt }),
          );
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
      let contractViolations: string[] = [];
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
          contractViolations = applyContract(c, scored, { output });
          verdict = verdictFor(c, scored.passed ?? false, baselinePassed);
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
                ...(contractViolations.length ? { contractViolations } : {}),
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
      // the recorded run's tool calls are its recordings (accepted paths excluded: they were not made)
      applyContract(c, r, {
        output: c.originalOutput,
        steps: Object.values(c.toolRecordings)
          .filter((rec) => !rec.equivalentOf)
          .map((rec) => ({ kind: "tool_call", name: rec.name })),
      });
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
    const latencies: number[] = [];
    for (const r of rows) {
      verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      if (r.passed === true) passed++;
      else if (r.passed === false) failed++;
      if (r.latencyMs != null && r.error === null) latencies.push(r.latencyMs);
    }
    const scored = passed + failed;
    latencies.sort((a, b) => a - b);
    const latencyP50Ms = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null;
    return {
      latencyP50Ms,
      costPerCallUsd: rows.length && costUsd > 0 ? costUsd / rows.length : null,
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

  // ---------- trajectory model calls (the SDK in replay mode calls the target model through the server) ----------

  async modelCall(projectId: string, req: ReplayModelCallRequest): Promise<ReplayModelCallResponse> {
    const { provider } = parseModel(req.model);
    if (!this.registry.isConfigured(provider))
      throw new BadRequestException(
        `Provider "${provider}" is not configured on this server (missing API key)`,
      );
    const systemPrompt = req.promptVersion
      ? (await this.prompts.resolve(projectId, req.promptVersion)).template
      : null;
    const { provider: inputProvider, params, ...rest } = req.input;
    const frozen: FrozenInput = {
      name: "replay",
      provider: inputProvider,
      model: null,
      params: params ?? null,
      ...rest,
    };
    const cacheInput = { frozen, systemPrompt };
    const hit = await this.cached(req.model, cacheInput);
    if (hit) return hit.output as ReplayModelCallResponse;
    const model = this.registry.languageModel(req.model);
    const res = await this.withRetry(provider, () => callModel(model, frozen, { systemPrompt }));
    const out: ReplayModelCallResponse = {
      text: res.text,
      toolCalls: res.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args ?? {} })),
      finishReason: res.finishReason,
      usage: res.usage,
      modelId: res.modelId,
      costUsd: estimateCostUsd(req.model, res.usage),
    };
    await this.cache(req.model, cacheInput, out, out.costUsd, res.usage);
    return out;
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
      let contractViolations: string[] = [];
      let newPath: ReportRow["newPath"] | undefined;
      if (r.unreplayable?.reason === "unseen") {
        // a tool call with no recording: not a failure yet, a path a human has to accept or reject
        verdict = "new_path";
        const { toolName, args } = r.unreplayable;
        newPath = {
          toolName,
          args,
          fingerprint: toolFingerprint(toolName, args),
          candidates: Object.entries(c.toolRecordings)
            .filter(([, rec]) => rec.name === toolName)
            .map(([fp, rec]) => ({ fingerprint: fp, args: rec.args })),
        };
        scored.reason = `new path: ${toolName}(${JSON.stringify(args)}) has no recording${newPath.candidates.length ? `; ${newPath.candidates.length} recorded call${newPath.candidates.length === 1 ? "" : "s"} of ${toolName} to compare` : "; this tool was never called in the recording"}`;
      } else if (r.unreplayable) {
        verdict = "unreplayable";
        scored.reason = `side-effect tool refused: ${r.unreplayable.toolName}(${JSON.stringify(r.unreplayable.args)})`;
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
          contractViolations = applyContract(c, scored, { output: r.output ?? null, steps: r.steps });
          verdict = verdictFor(c, scored.passed ?? false, baselinePassed);
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
          refusedSideEffects: r.refusedSideEffects ?? null,
          ...(newPath ? { newPath } : {}),
          ...(contractViolations.length ? { contractViolations } : {}),
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
      ...trajectoryExtras(r.diff),
    });
    const all = rows.map(toRow).sort((a, b) => a.title.localeCompare(b.title));
    const [projectRow] = await this.db.execute(sql`select settings from projects where id = ${projectId}`);
    const settings = parseSettings((projectRow as { settings?: unknown } | undefined)?.settings);
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
      newPaths: all.filter((x) => x.verdict === "new_path"),
      stillWrong: all.filter((x) => x.verdict === "fail"),
      fixed: all.filter((x) => x.verdict === "fixed"),
      passed: all.filter((x) => x.verdict === "pass"),
      unreplayable: all.filter((x) => x.verdict === "unreplayable"),
      errors: all.filter((x) => x.verdict === "error"),
      gate: gateFor(all, settings.newPathsBlock),
    };
  }
}

/**
 * Challenger scorecard: every job in a group against the incumbent — the job whose model the
 * cases were recorded with, else the first job. Pass-rate points and cost ratio are what a team
 * needs to see that an open model matches the one they pay for.
 */
export function scorecardFor(jobs: ReplayJob[], recordedModel: string | null): ScorecardRow[] {
  const same = (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase() ||
    a.toLowerCase().endsWith(`/${b.toLowerCase()}`) ||
    b.toLowerCase().endsWith(`/${a.toLowerCase()}`);
  const incumbentIdx = recordedModel
    ? jobs.findIndex((j) => same(j.targetModel, recordedModel) && !(j.options?.examples > 0))
    : -1;
  const inc = jobs[incumbentIdx >= 0 ? incumbentIdx : 0];
  const rowOf = (j: ReplayJob): ScorecardRow => ({
    jobId: j.id,
    model: j.options?.examples > 0 ? `${j.targetModel} +${j.options.examples} examples` : j.targetModel,
    incumbent: j === inc,
    status: j.status,
    passRate: j.summary?.passRate ?? null,
    regressions: j.summary?.verdicts.regression ?? 0,
    costPerCallUsd: j.summary?.costPerCallUsd ?? null,
    latencyP50Ms: j.summary?.latencyP50Ms ?? null,
    pricePerMTokens: priceFor(j.targetModel),
    vsIncumbent: null,
  });
  const rows = jobs.map(rowOf);
  const base = rows.find((r) => r.incumbent)!;
  for (const r of rows) {
    if (r.incumbent) continue;
    r.vsIncumbent = {
      passRatePoints:
        r.passRate != null && base.passRate != null
          ? Math.round((r.passRate - base.passRate) * 1000) / 10
          : null,
      costRatio:
        r.costPerCallUsd != null && base.costPerCallUsd
          ? Math.round((r.costPerCallUsd / base.costPerCallUsd) * 100) / 100
          : r.pricePerMTokens && base.pricePerMTokens
            ? Math.round(
                ((r.pricePerMTokens[0] + r.pricePerMTokens[1]) /
                  (base.pricePerMTokens[0] + base.pricePerMTokens[1])) *
                  100,
              ) / 100
            : null,
    };
  }
  return rows;
}

/** The CI verdict: regressions always block; new paths block until accepted unless the project says otherwise. */
export function gateFor(rows: ReportRow[], newPathsBlock: boolean): NonNullable<ReplayReport["gate"]> {
  const reasons: string[] = [];
  const regressions = rows.filter((r) => r.verdict === "regression").length;
  const newPaths = rows.filter((r) => r.verdict === "new_path").length;
  if (regressions > 0) reasons.push(`${regressions} regression${regressions === 1 ? "" : "s"}`);
  if (newPaths > 0 && newPathsBlock)
    reasons.push(`${newPaths} new path${newPaths === 1 ? "" : "s"} not yet accepted`);
  return { pass: reasons.length === 0, reasons, newPathsBlock };
}

/** Report columns that only exist for trajectory replays (see POST /v1/replays/:id/results). */
function trajectoryExtras(
  diff: unknown,
): Pick<
  ReportRow,
  "refusedSideEffects" | "stepCount" | "simulatedToolCalls" | "newPath" | "contractViolations"
> {
  const d = diff as {
    refusedSideEffects?: { toolName: string; args: unknown }[];
    steps?: { kind?: string }[];
    newPath?: ReportRow["newPath"];
    contractViolations?: string[];
  } | null;
  if (!d) return {};
  return {
    ...(d.newPath ? { newPath: d.newPath } : {}),
    ...(Array.isArray(d.contractViolations) ? { contractViolations: d.contractViolations } : {}),
    ...(Array.isArray(d.refusedSideEffects)
      ? { refusedSideEffects: d.refusedSideEffects as ReportRow["refusedSideEffects"] }
      : {}),
    ...(Array.isArray(d.steps)
      ? {
          stepCount: d.steps.length,
          simulatedToolCalls: d.steps.filter((s) => s && typeof s === "object" && s.kind === "tool_call")
            .length,
        }
      : {}),
  };
}
