import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../config";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { projects, runs } from "../db/schema";
import { parseSettings } from "../projects/settings";

const EXCERPT = 400;
const TIMEOUT_MS = 8000;

export interface ReviewMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

/**
 * Posts completed runs to the project's review webhook (Slack incoming webhook
 * format) so the human correction loop can start from Slack: every message has a
 * Review button (the run page) and an Approve button (the run page with the approve
 * dialog open). Nothing is written from Slack directly; the buttons are plain links.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * Claims the given runs (finished, not yet notified) and posts each one to the
   * webhook if one is configured. A run is posted at most once, and runs that
   * finished before the webhook was configured are never back-filled.
   */
  async notifyCompletedRuns(projectId: string, runIds: string[]): Promise<number> {
    if (runIds.length === 0) return 0;
    const claimed = await this.db
      .update(runs)
      .set({ notifiedAt: sql`now()` })
      .where(
        and(
          eq(runs.projectId, projectId),
          inArray(runs.id, runIds),
          ne(runs.status, "running"),
          isNull(runs.notifiedAt),
        ),
      )
      .returning();
    if (claimed.length === 0) return 0;
    const url = await this.webhookUrl(projectId);
    if (!url) return 0;
    let posted = 0;
    for (const run of claimed) {
      const ok = await this.post(url, this.messageFor(run));
      if (ok) posted += 1;
    }
    return posted;
  }

  /** Sends a sample message so the user can confirm the webhook works. */
  async sendTest(projectId: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    const url = await this.webhookUrl(projectId);
    if (!url) return { ok: false, error: "no review webhook configured" };
    return this.postDetailed(url, {
      text: "Overturn is connected. Completed runs will show up here with Review and Approve buttons.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*Overturn is connected.* Completed runs will show up here with Review and Approve buttons.",
          },
        },
      ],
    });
  }

  messageFor(run: typeof runs.$inferSelect): ReviewMessage {
    const runUrl = `${this.config.WEB_URL}/runs/${run.id}`;
    const status = run.status === "failed" ? "failed" : "completed";
    const title = `${run.agent}${run.agentVersion ? ` ${run.agentVersion}` : ""} ${status} · ${run.stepCount} steps`;
    const blocks: ReviewMessage["blocks"] = [
      { type: "section", text: { type: "mrkdwn", text: `*<${runUrl}|${mrkdwn(title)}>*` } },
    ];
    const input = excerpt(run.input);
    const output = excerpt(run.error ? { error: run.error } : run.output);
    if (input || output) {
      blocks.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Input*\n${mrkdwn(input || "—")}` },
          { type: "mrkdwn", text: `*Output*\n${mrkdwn(output || "—")}` },
        ],
      });
    }
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Review" }, url: runUrl },
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          url: `${runUrl}?approve=1`,
        },
      ],
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `run \`${run.id.slice(-8)}\`${run.tags.length ? ` · ${run.tags.join(", ")}` : ""}`,
        },
      ],
    });
    return { text: `${title} — ${runUrl}`, blocks };
  }

  private async webhookUrl(projectId: string): Promise<string | null> {
    const [p] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return p ? parseSettings(p.settings).reviewWebhookUrl : null;
  }

  private async post(url: string, message: ReviewMessage): Promise<boolean> {
    const res = await this.postDetailed(url, message);
    if (!res.ok) this.logger.warn(`review webhook failed: ${res.error ?? `HTTP ${res.status}`}`);
    return res.ok;
  }

  private async postDetailed(
    url: string,
    message: ReviewMessage,
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { ok: res.ok, status: res.status, error: res.ok ? undefined : (await res.text()).slice(0, 200) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function excerpt(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > EXCERPT ? `${s.slice(0, EXCERPT)}…` : s;
}

function mrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
