import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { projectSettingsSchema } from "@overturn/shared";
import PgBoss from "pg-boss";
import { APP_CONFIG, type AppConfig } from "../config";
import { CorrectionsService } from "../corrections/corrections.service";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { projects } from "../db/schema";

export const IMPLICIT_APPROVE_JOB = "implicit-approve";

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
    await this.boss.work(IMPLICIT_APPROVE_JOB, async () => {
      await this.runImplicitApprovals();
    });
    await this.boss.schedule(IMPLICIT_APPROVE_JOB, "17 * * * *", undefined, { tz: "UTC" });
    this.logger.log("pg-boss started");
  }

  async onModuleDestroy(): Promise<void> {
    if (this.started) await this.boss.stop({ graceful: true, timeout: 5000 });
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
