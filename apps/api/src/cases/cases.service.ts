import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  Case,
  CaseFilter,
  CaseListQuery,
  CasePatch,
  CaseSet,
  CaseSetCreate,
  CaseSummary,
  Page,
  ToolRecordingEntry,
} from "@overturn-ai/shared";
import { and, desc, eq, gte, inArray, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { type CaseRow, caseSets, cases, corrections, replayJobs, replayResults } from "../db/schema";

type CaseJoined = CaseRow & { note: string | null; actor: string | null };

export function serializeCase(r: CaseJoined): Case {
  return {
    id: r.id,
    projectId: r.projectId,
    correctionId: r.correctionId,
    runId: r.runId,
    stepId: r.stepId,
    agent: r.agent,
    agentVersion: r.agentVersion,
    kind: r.kind,
    title: r.title,
    frozenInput: r.frozenInput as Case["frozenInput"],
    toolRecordings: r.toolRecordings as Record<string, ToolRecordingEntry>,
    originalOutput: r.originalOutput,
    expected: r.expected,
    scorer: r.scorer as Case["scorer"],
    scorerConfig: (r.scorerConfig ?? {}) as Case["scorerConfig"],
    tags: r.tags,
    status: r.status,
    truncated: r.truncated,
    recordedModel: r.recordedModel,
    lastVerdict: r.lastVerdict,
    note: r.note,
    actor: r.actor,
    createdAt: r.createdAt.toISOString(),
  };
}

export function serializeCaseSummary(r: CaseJoined): CaseSummary {
  const { frozenInput: _f, toolRecordings: _t, ...rest } = serializeCase(r);
  return rest;
}

function encodeCursor(r: CaseRow): string {
  return Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString("base64url");
}
function decodeCursor(c: string): { createdAt: Date; id: string } | null {
  try {
    const [ts, id] = Buffer.from(c, "base64url").toString().split("|");
    if (!ts || !id) return null;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : { createdAt: d, id };
  } catch {
    return null;
  }
}

@Injectable()
export class CasesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Resolves a saved set (by name or id) and merges its filter; explicit filters win. */
  async resolveFilter(projectId: string, filter: CaseFilter): Promise<CaseFilter> {
    if (!filter.set) return filter;
    const isUuid = /^[0-9a-f-]{36}$/i.test(filter.set);
    const [set] = await this.db
      .select()
      .from(caseSets)
      .where(
        and(
          eq(caseSets.projectId, projectId),
          isUuid ? eq(caseSets.id, filter.set) : eq(caseSets.name, filter.set),
        ),
      )
      .limit(1);
    if (!set) throw new NotFoundException(`Case set "${filter.set}" not found`);
    const saved = (set.filter ?? {}) as Partial<CaseFilter>;
    const { set: _s, ...explicit } = filter;
    const merged: CaseFilter = { ...explicit };
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined && (merged as Record<string, unknown>)[k] === undefined)
        (merged as Record<string, unknown>)[k] = v;
    }
    if (explicit.status === "active" && saved.status) merged.status = saved.status;
    return merged;
  }

  whereFor(projectId: string, f: CaseFilter): SQL[] {
    const where: SQL[] = [eq(cases.projectId, projectId)];
    if (f.status) where.push(eq(cases.status, f.status));
    if (f.agent) where.push(eq(cases.agent, f.agent));
    if (f.kind) where.push(eq(cases.kind, f.kind));
    if (f.tag) where.push(sql`${f.tag} = any(${cases.tags})`);
    if (f.since) where.push(gte(cases.createdAt, new Date(f.since)));
    if (f.until) where.push(lte(cases.createdAt, new Date(f.until)));
    if (f.ids && f.ids.length > 0) where.push(inArray(cases.id, f.ids));
    return where;
  }

  async list(projectId: string, q: CaseListQuery): Promise<Page<CaseSummary>> {
    const { limit, cursor, ...rawFilter } = q;
    const filter = await this.resolveFilter(projectId, rawFilter);
    const where = this.whereFor(projectId, filter);
    if (cursor) {
      const c = decodeCursor(cursor);
      if (c)
        where.push(
          or(lt(cases.createdAt, c.createdAt), and(eq(cases.createdAt, c.createdAt), lt(cases.id, c.id)))!,
        );
    }
    const rows = await this.db
      .select({ c: cases, note: corrections.note, actor: corrections.actor })
      .from(cases)
      .innerJoin(corrections, eq(corrections.id, cases.correctionId))
      .where(and(...where))
      .orderBy(desc(cases.createdAt), desc(cases.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => serializeCaseSummary({ ...r.c, note: r.note, actor: r.actor })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.c) : null,
    };
  }

  /** Every matching case, full rows, for replay. */
  async findAll(projectId: string, rawFilter: CaseFilter): Promise<Case[]> {
    const filter = await this.resolveFilter(projectId, rawFilter);
    const rows = await this.db
      .select({ c: cases, note: corrections.note, actor: corrections.actor })
      .from(cases)
      .innerJoin(corrections, eq(corrections.id, cases.correctionId))
      .where(and(...this.whereFor(projectId, filter)))
      .orderBy(desc(cases.createdAt));
    return rows.map((r) => serializeCase({ ...r.c, note: r.note, actor: r.actor }));
  }

  async get(projectId: string, id: string): Promise<Case> {
    const [row] = await this.db
      .select({ c: cases, note: corrections.note, actor: corrections.actor })
      .from(cases)
      .innerJoin(corrections, eq(corrections.id, cases.correctionId))
      .where(and(eq(cases.projectId, projectId), eq(cases.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException(`Case ${id} not found`);
    return serializeCase({ ...row.c, note: row.note, actor: row.actor });
  }

  async patch(projectId: string, id: string, patch: CasePatch): Promise<Case> {
    const set: Partial<typeof cases.$inferInsert> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.tags !== undefined) set.tags = patch.tags;
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.scorer !== undefined) set.scorer = patch.scorer;
    if (patch.scorerConfig !== undefined) set.scorerConfig = patch.scorerConfig;
    if (patch.expected !== undefined) set.expected = patch.expected;
    if (Object.keys(set).length > 0) {
      const rows = await this.db
        .update(cases)
        .set(set)
        .where(and(eq(cases.projectId, projectId), eq(cases.id, id)))
        .returning({ id: cases.id });
      if (rows.length === 0) throw new NotFoundException(`Case ${id} not found`);
    }
    return this.get(projectId, id);
  }

  async count(projectId: string, rawFilter: CaseFilter): Promise<number> {
    const filter = await this.resolveFilter(projectId, rawFilter);
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(cases)
      .where(and(...this.whereFor(projectId, filter)));
    return row?.n ?? 0;
  }

  async results(projectId: string, caseId: string) {
    await this.get(projectId, caseId);
    const rows = await this.db
      .select({ r: replayResults, job: replayJobs })
      .from(replayResults)
      .innerJoin(replayJobs, eq(replayJobs.id, replayResults.jobId))
      .where(eq(replayResults.caseId, caseId))
      .orderBy(desc(replayResults.createdAt));
    return rows.map(({ r, job }) => ({
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
      targetModel: job.targetModel,
      targetPromptVersion: job.targetPromptVersion,
      mode: job.mode,
    }));
  }

  // ---- case sets ----

  async createSet(projectId: string, input: CaseSetCreate): Promise<CaseSet> {
    const [row] = await this.db
      .insert(caseSets)
      .values({ id: uuidv7(), projectId, name: input.name, filter: input.filter })
      .returning();
    return {
      id: row!.id,
      projectId,
      name: row!.name,
      filter: row!.filter,
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async listSets(projectId: string): Promise<CaseSet[]> {
    const rows = await this.db
      .select()
      .from(caseSets)
      .where(eq(caseSets.projectId, projectId))
      .orderBy(caseSets.name);
    return rows.map((r) => ({
      id: r.id,
      projectId,
      name: r.name,
      filter: r.filter,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async deleteSet(projectId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(caseSets)
      .where(and(eq(caseSets.projectId, projectId), eq(caseSets.id, id)))
      .returning({ id: caseSets.id });
    if (rows.length === 0) throw new NotFoundException(`Case set ${id} not found`);
  }
}
