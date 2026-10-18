import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Page, Run, RunListQuery, RunWithSteps, Step } from "@overturn-ai/shared";
import { and, asc, desc, eq, getTableColumns, gt, gte, lt, lte, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { type RunRow, runs, type StepRow, steps } from "../db/schema";

export function serializeRun(r: RunRow): Run {
  return {
    id: r.id,
    projectId: r.projectId,
    externalId: r.externalId,
    agent: r.agent,
    agentVersion: r.agentVersion,
    status: r.status,
    input: r.input,
    output: r.output,
    metadata: (r.metadata ?? null) as Run["metadata"],
    tags: r.tags,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    error: r.error,
    stepCount: r.stepCount,
    correctionCount: r.correctionCount,
    costUsd: r.costUsd,
    createdAt: r.createdAt.toISOString(),
  };
}

export function serializeStep(s: StepRow): Step {
  return {
    id: s.id,
    runId: s.runId,
    parentStepId: s.parentStepId,
    seq: s.seq,
    kind: s.kind,
    name: s.name,
    input: s.input,
    output: s.output,
    model: s.model,
    provider: s.provider,
    params: (s.params ?? null) as Step["params"],
    usage: (s.usage ?? null) as Step["usage"],
    costUsd: s.costUsd,
    latencyMs: s.latencyMs,
    error: s.error,
    sideEffect: s.sideEffect,
    fingerprint: s.fingerprint,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Cursor = "<startedAt ISO>|<id>", keyset pagination ordered by started_at desc, id desc. */
function encodeCursor(r: RunRow): string {
  return Buffer.from(`${r.startedAt.toISOString()}|${r.id}`).toString("base64url");
}
function decodeCursor(c: string): { startedAt: Date; id: string } | null {
  try {
    const [ts, id] = Buffer.from(c, "base64url").toString().split("|");
    if (!ts || !id) return null;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return { startedAt: d, id };
  } catch {
    return null;
  }
}

/** Max bytes of input/output embedded in list rows (see list()). */
const LIST_BODY_LIMIT = 8 * 1024;

@Injectable()
export class RunsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(projectId: string, q: RunListQuery): Promise<Page<Run>> {
    const where: SQL[] = [eq(runs.projectId, projectId)];
    if (q.agent) where.push(eq(runs.agent, q.agent));
    if (q.status) where.push(eq(runs.status, q.status));
    if (q.tag) where.push(sql`${q.tag} = any(${runs.tags})`);
    if (q.corrected === "true") where.push(gt(runs.correctionCount, 0));
    if (q.corrected === "false") where.push(eq(runs.correctionCount, 0));
    if (q.since) where.push(gte(runs.startedAt, new Date(q.since)));
    if (q.until) where.push(lte(runs.startedAt, new Date(q.until)));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (c) {
        where.push(
          or(lt(runs.startedAt, c.startedAt), and(eq(runs.startedAt, c.startedAt), lt(runs.id, c.id)))!,
        );
      }
    }
    // Lists carry input/output only when small; big bodies are replaced by a size marker and
    // fetched from GET /v1/runs/:id. Keeps a list page from weighing megabytes.
    const rows = await this.db
      .select({
        ...getTableColumns(runs),
        input: sql<unknown>`case when octet_length(${runs.input}::text) <= ${LIST_BODY_LIMIT} then ${runs.input} else jsonb_build_object('$truncated', octet_length(${runs.input}::text)) end`,
        output: sql<unknown>`case when octet_length(${runs.output}::text) <= ${LIST_BODY_LIMIT} then ${runs.output} else jsonb_build_object('$truncated', octet_length(${runs.output}::text)) end`,
      })
      .from(runs)
      .where(and(...where))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(serializeRun),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
    };
  }

  async get(projectId: string, id: string): Promise<RunWithSteps> {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, projectId), eq(runs.id, id)))
      .limit(1);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    const stepRows = await this.db.select().from(steps).where(eq(steps.runId, id)).orderBy(asc(steps.seq));
    return { ...serializeRun(run), steps: stepRows.map(serializeStep) };
  }

  async stats(projectId: string): Promise<{ runs7d: number; corrected7d: number; correctedRate7d: number }> {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        corrected: sql<number>`count(*) filter (where ${runs.correctionCount} > 0)::int`,
      })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), gte(runs.startedAt, since)));
    const total = row?.total ?? 0;
    const corrected = row?.corrected ?? 0;
    return { runs7d: total, corrected7d: corrected, correctedRate7d: total === 0 ? 0 : corrected / total };
  }
}
