import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  type Case,
  type CaseConflict,
  type CaseCounts,
  type CaseDedupeResult,
  type CaseEquivalent,
  type CaseFilter,
  type CaseListQuery,
  type CasePatch,
  type CaseSet,
  type CaseSetCreate,
  type CaseSummary,
  caseInputHash,
  fingerprint as fingerprintOf,
  type Page,
  type ToolRecordingEntry,
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
    contract: (r.contract ?? []) as Case["contract"],
    recordedModel: r.recordedModel,
    lastVerdict: r.lastVerdict,
    duplicates: r.duplicates,
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
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
    if (patch.contract !== undefined) set.contract = patch.contract;
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

  /** How many cases are in the suite, suppressed from it, or archived — so a shrinking suite is visible. */
  /** Backfills input_hash for cases created before duplicate detection existed. Idempotent. */
  async ensureHashed(projectId: string, db: Db = this.db): Promise<void> {
    const rows = await db
      .select({ id: cases.id, agent: cases.agent, frozenInput: cases.frozenInput })
      .from(cases)
      .where(and(eq(cases.projectId, projectId), sql`${cases.inputHash} is null`))
      .limit(5000);
    for (const r of rows)
      await db
        .update(cases)
        .set({ inputHash: caseInputHash(r.agent, r.frozenInput as Record<string, unknown>) })
        .where(eq(cases.id, r.id));
  }

  /**
   * The active case this input, kind and answer already have, if any. A correction that matches
   * is the same test made again, and is merged into it rather than added beside it.
   */
  async findDuplicate(
    projectId: string,
    key: { agent: string; frozenInput: Record<string, unknown>; kind: Case["kind"]; expected: unknown },
    db: Db = this.db,
  ): Promise<CaseRow | null> {
    await this.ensureHashed(projectId, db);
    const hash = caseInputHash(key.agent, key.frozenInput);
    const rows = await db
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          eq(cases.inputHash, hash),
          eq(cases.kind, key.kind),
          eq(cases.status, "active"),
        ),
      )
      .orderBy(cases.createdAt);
    const want = JSON.stringify(key.expected ?? null);
    return rows.find((r) => JSON.stringify(r.expected ?? null) === want) ?? null;
  }

  /**
   * Suite hygiene: merges cases that share input, kind and answer into the oldest active one.
   * The duplicates are deleted (their corrections stay), the keeper's duplicate count absorbs them.
   */
  async dedupe(projectId: string): Promise<CaseDedupeResult> {
    await this.ensureHashed(projectId);
    const rows = await this.db
      .select({
        id: cases.id,
        inputHash: cases.inputHash,
        kind: cases.kind,
        expected: cases.expected,
        duplicates: cases.duplicates,
        createdAt: cases.createdAt,
      })
      .from(cases)
      .where(and(eq(cases.projectId, projectId), eq(cases.status, "active")))
      .orderBy(cases.createdAt, cases.id);
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.inputHash}|${r.kind}|${JSON.stringify(r.expected ?? null)}`;
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    let merged = 0;
    let kept = 0;
    await this.db.transaction(async (tx) => {
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        const [keeper, ...dups] = g;
        const absorbed = dups.reduce((n, d) => n + 1 + d.duplicates, 0);
        const latest = dups.reduce((t, d) => (d.createdAt > t ? d.createdAt : t), keeper!.createdAt);
        await tx
          .update(cases)
          .set({ duplicates: sql`${cases.duplicates} + ${absorbed}`, lastSeenAt: latest })
          .where(eq(cases.id, keeper!.id));
        await tx.delete(cases).where(
          inArray(
            cases.id,
            dups.map((d) => d.id),
          ),
        );
        merged += dups.length;
        kept++;
      }
    });
    return { merged, kept };
  }

  async counts(projectId: string): Promise<CaseCounts> {
    const rows = await this.db
      .select({ status: cases.status, n: sql<number>`count(*)::int` })
      .from(cases)
      .where(eq(cases.projectId, projectId))
      .groupBy(cases.status);
    const out: CaseCounts = { active: 0, suppressed: 0, archived: 0, conflicts: 0 };
    for (const r of rows) out[r.status] = r.n;
    out.conflicts = (await this.conflicts(projectId)).length;
    return out;
  }

  /**
   * Suite hygiene: inputs that have more than one active case with different answers. Two humans
   * (or one human twice) disagreed; until someone suppresses or re-corrects, every replay fails at
   * least one of them and the suite is arguing with itself.
   */
  async conflicts(projectId: string): Promise<CaseConflict[]> {
    await this.ensureHashed(projectId);
    const rows = await this.db
      .select({
        id: cases.id,
        inputHash: cases.inputHash,
        agent: cases.agent,
        title: cases.title,
        kind: cases.kind,
        expected: cases.expected,
        createdAt: cases.createdAt,
        duplicates: cases.duplicates,
        note: sql<string | null>`(select note from corrections where corrections.id = ${cases.correctionId})`,
        actor: sql<
          string | null
        >`(select actor from corrections where corrections.id = ${cases.correctionId})`,
      })
      .from(cases)
      .where(
        and(
          eq(cases.projectId, projectId),
          eq(cases.status, "active"),
          sql`${cases.inputHash} in (select input_hash from cases c2 where c2.project_id = ${projectId} and c2.status = 'active' and c2.input_hash is not null group by input_hash having count(*) > 1)`,
        ),
      )
      .orderBy(cases.inputHash, cases.createdAt);
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const g = groups.get(r.inputHash!);
      if (g) g.push(r);
      else groups.set(r.inputHash!, [r]);
    }
    const out: CaseConflict[] = [];
    for (const [inputHash, g] of groups) {
      const answers = new Set(g.map((r) => `${r.kind}|${JSON.stringify(r.expected ?? null)}`));
      if (answers.size < 2) continue;
      out.push({
        inputHash,
        agent: g[0]!.agent,
        cases: g.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          expected: r.expected,
          actor: r.actor,
          note: r.note,
          createdAt: r.createdAt.toISOString(),
          duplicates: r.duplicates,
        })),
      });
    }
    return out;
  }

  /**
   * A human accepts a tool call the agent made in replay as equivalent to a recorded one: the
   * recorded output is copied under the new call's fingerprint, so future replays answer it, and
   * the replay result that surfaced it is re-scored under the human's original decision.
   */
  async acceptEquivalent(projectId: string, id: string, input: CaseEquivalent): Promise<Case> {
    const c = await this.get(projectId, id);
    const source = c.toolRecordings[input.equivalentOf];
    if (!source) throw new BadRequestException(`No recording ${input.equivalentOf} on case ${id}`);
    if (source.name !== input.toolName)
      throw new BadRequestException(
        `Recording ${input.equivalentOf} is for ${source.name}, not ${input.toolName}`,
      );
    const fp = fingerprintOf("tool_call", input.toolName, input.args);
    const entry: ToolRecordingEntry = {
      name: input.toolName,
      args: input.args,
      output: source.output,
      sideEffect: source.sideEffect,
      equivalentOf: source.equivalentOf ?? input.equivalentOf,
      note: input.note ?? null,
      acceptedAt: new Date().toISOString(),
      acceptedBy: input.actor ?? null,
    };
    await this.db
      .update(cases)
      .set({ toolRecordings: { ...c.toolRecordings, [fp]: entry } })
      .where(and(eq(cases.projectId, projectId), eq(cases.id, id)));
    if (input.jobId) {
      // the result that surfaced the new path now stands as the human's original decision
      const reason = `new path accepted as equivalent to ${source.name}(${JSON.stringify(source.args)})${input.note ? ` — ${input.note}` : ""}`;
      await this.db
        .update(replayResults)
        .set({ verdict: "pass", passed: true, reason })
        .where(
          and(
            eq(replayResults.projectId, projectId),
            eq(replayResults.jobId, input.jobId),
            eq(replayResults.caseId, id),
            eq(replayResults.verdict, "new_path"),
          ),
        );
      await this.db.update(cases).set({ lastVerdict: "pass" }).where(eq(cases.id, id));
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
