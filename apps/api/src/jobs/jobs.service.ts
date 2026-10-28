import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { projectSettingsSchema } from "@overturn-ai/shared";
import PgBoss from "pg-boss";
import { APP_CONFIG, type AppConfig } from "../config";
import { CorrectionsService } from "../corrections/corrections.service";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { projects } from "../db/schema";
import { ReplayService } from "../replay/replay.service";
import { RunsService } from "../runs/runs.service";
import { TrainingService } from "../training/training.service";

export const IMPLICIT_APPROVE_JOB = "implicit-approve";
export const REPLAY_JOB = "replay";
export const CACHE_PURGE_JOB = "cache-purge";
export const RETENTION_JOB = "retention";
export const TRAIN_JOB = "train";
export const TRAIN_POLL_JOB = "train-poll";
export const SHADOW_JOB = "shadow";

/**
 * Background jobs on pg-boss (same Postgres, schema "pgboss"). Started unless
 * JOBS_DISABLED=1 (tests start it explicitly where needed).
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  readonly boss: PgBoss;
  private started = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly corrections: CorrectionsService,
    private readonly replay: ReplayService,
    private readonly runs: RunsService,
    private readonly training: TrainingService,
  ) {
    this.boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: "pgboss", max: 4 });
    this.boss.on("error", (err) => this.logger.error(err.message));
  }

  async onModuleInit(): Promise<void> {
    if (this.config.JOBS_DISABLED) return;
    await this.start();
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    this.started = true;
    // pg-boss 10 requires queues to exist before work()/schedule(); createQueue is idempotent
    for (const name of [
      IMPLICIT_APPROVE_JOB,
      CACHE_PURGE_JOB,
      RETENTION_JOB,
      REPLAY_JOB,
      TRAIN_JOB,
      TRAIN_POLL_JOB,
      SHADOW_JOB,
    ]) {
      await this.boss.createQueue(name);
    }
    await this.boss.work(IMPLICIT_APPROVE_JOB, async () => {
      await this.runImplicitApprovals();
    });
    await this.boss.schedule(IMPLICIT_APPROVE_JOB, "17 * * * *", undefined, { tz: "UTC" });
    await this.boss.work(CACHE_PURGE_JOB, async () => {
      await this.replay.purgeExpiredCache();
    });
    await this.boss.schedule(CACHE_PURGE_JOB, "41 * * * *", undefined, { tz: "UTC" });
    await this.boss.work(RETENTION_JOB, async () => {
      await this.runRetention();
    });
    await this.boss.schedule(RETENTION_JOB, "23 3 * * *", undefined, { tz: "UTC" });
    await this.boss.work<{ jobId: string }>(REPLAY_JOB, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      this.logger.log(`replay ${job.data.jobId} started`);
      const result = await this.replay.runJob(job.data.jobId);
      this.logger.log(
        `replay ${job.data.jobId} ${result.status}: ${JSON.stringify(result.summary?.verdicts ?? {})}`,
      );
    });
    await this.boss.work<{ modelId: string }>(TRAIN_JOB, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      const m = await this.training.start(job.data.modelId);
      this.logger.log(`training ${m.id}: ${m.status}`);
    });
    // every minute: poll running fine-tunes (gate on completion), answer live runs in shadow, score shadows
    await this.boss.work(TRAIN_POLL_JOB, async () => {
      for (const id of await this.training.training()) {
        const m = await this.training.poll(id);
        if (m.status !== "training") this.logger.log(`training ${id}: ${m.status}`);
      }
    });
    await this.boss.schedule(TRAIN_POLL_JOB, "* * * * *", undefined, { tz: "UTC" });
    await this.boss.work(SHADOW_JOB, async () => {
      const n = await this.training.shadowSweep();
      const scored = await this.training.shadowScoreSweep();
      if (n || scored) this.logger.log(`shadow: ${n} runs answered, ${scored} scored`);
    });
    await this.boss.schedule(SHADOW_JOB, "* * * * *", undefined, { tz: "UTC" });
    this.logger.log("pg-boss started");
  }

  async onModuleDestroy(): Promise<void> {
    if (this.started) await this.boss.stop({ graceful: true, timeout: 5000 });
  }

  /** Queues a step-mode replay job. Runs inline when jobs are disabled (tests, single-process dev). */
  async enqueueReplay(jobId: string): Promise<void> {
    if (!this.started) {
      // fire and forget so the HTTP response returns immediately; tests poll or call runJob directly
      void this.replay
        .runJob(jobId)
        .catch((err: unknown) => this.logger.error(`replay ${jobId} failed: ${String(err)}`));
      return;
    }
    await this.boss.send(
      REPLAY_JOB,
      { jobId },
      { retryLimit: 1, expireInSeconds: 6 * 3600, singletonKey: jobId },
    );
  }

  /** Queues a training run (export → upload → fine-tune); the poll job gates it when it finishes. */
  async enqueueTraining(modelId: string): Promise<void> {
    if (!this.started) {
      void this.training
        .runToCompletion(modelId)
        .catch((err: unknown) => this.logger.error(`training ${modelId} failed: ${String(err)}`));
      return;
    }
    await this.boss.send(
      TRAIN_JOB,
      { modelId },
      { retryLimit: 0, expireInSeconds: 3600, singletonKey: modelId },
    );
  }

  /** Deletes case-less runs past each project's retentionDays. Returns runs deleted. */
  async runRetention(): Promise<number> {
    const rows = await this.db.select({ id: projects.id, settings: projects.settings }).from(projects);
    let total = 0;
    for (const p of rows) {
      const parsed = projectSettingsSchema.safeParse(p.settings ?? {});
      const days = parsed.success ? parsed.data.retentionDays : 90;
      total += await this.runs.purgeExpired(p.id, days);
    }
    if (total > 0) this.logger.log(`retention deleted ${total} runs`);
    return total;
  }

  /** Sweeps every project with implicitApproveAfterDays > 0. Returns corrections created. */
  async runImplicitApprovals(): Promise<number> {
    const rows = await this.db.select({ id: projects.id, settings: projects.settings }).from(projects);
    let total = 0;
    for (const p of rows) {
      const parsed = projectSettingsSchema.safeParse(p.settings ?? {});
      const days = parsed.success ? parsed.data.implicitApproveAfterDays : 0;
      if (days > 0) total += await this.corrections.sweepImplicitApprovals(p.id, days);
    }
    if (total > 0) this.logger.log(`implicitly approved ${total} runs`);
    return total;
  }
}
