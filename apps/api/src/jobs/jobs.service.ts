import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { projectSettingsSchema } from "@overturn/shared";
import PgBoss from "pg-boss";
import { APP_CONFIG, type AppConfig } from "../config";
import { CorrectionsService } from "../corrections/corrections.service";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { projects } from "../db/schema";
import { ReplayService } from "../replay/replay.service";

export const IMPLICIT_APPROVE_JOB = "implicit-approve";
export const REPLAY_JOB = "replay";
export const CACHE_PURGE_JOB = "cache-purge";

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
    for (const name of [IMPLICIT_APPROVE_JOB, CACHE_PURGE_JOB, REPLAY_JOB]) await this.boss.createQueue(name);
    await this.boss.work(IMPLICIT_APPROVE_JOB, async () => {
      await this.runImplicitApprovals();
    });
    await this.boss.schedule(IMPLICIT_APPROVE_JOB, "17 * * * *", undefined, { tz: "UTC" });
    await this.boss.work(CACHE_PURGE_JOB, async () => {
      await this.replay.purgeExpiredCache();
    });
    await this.boss.schedule(CACHE_PURGE_JOB, "41 * * * *", undefined, { tz: "UTC" });
    await this.boss.work<{ jobId: string }>(REPLAY_JOB, { batchSize: 1 }, async ([job]) => {
      if (!job) return;
      this.logger.log(`replay ${job.data.jobId} started`);
      const result = await this.replay.runJob(job.data.jobId);
      this.logger.log(
        `replay ${job.data.jobId} ${result.status}: ${JSON.stringify(result.summary?.verdicts ?? {})}`,
      );
    });
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
