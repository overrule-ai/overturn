import { Inject, Injectable, Logger } from "@nestjs/common";
import type { IngestPayload, IngestResponse, RunUpsert, StepUpsert } from "@overturn/shared";
import { inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { runs, steps } from "../db/schema";

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  async ingest(projectId: string, payload: IngestPayload): Promise<IngestResponse> {
    const runIds = new Set<string>(payload.runs.map((r) => r.id));
    const stepRunIds = new Set<string>(payload.steps.map((s) => s.runId));

    await this.db.transaction(async (tx) => {
      if (payload.runs.length > 0) {
        await tx
          .insert(runs)
          .values(payload.runs.map((r) => toRunRow(projectId, r)))
          .onConflictDoUpdate({
            target: runs.id,
            set: {
              externalId: sql`coalesce(excluded.external_id, ${runs.externalId})`,
              agent: sql`case when excluded.agent = '' then ${runs.agent} else excluded.agent end`,
              agentVersion: sql`coalesce(excluded.agent_version, ${runs.agentVersion})`,
              // status only moves forward: running -> completed|failed
              status: sql`case when ${runs.status} = 'running' then excluded.status else ${runs.status} end`,
              input: sql`coalesce(excluded.input, ${runs.input})`,
              output: sql`coalesce(excluded.output, ${runs.output})`,
              metadata: sql`coalesce(excluded.metadata, ${runs.metadata})`,
              tags: sql`case when cardinality(excluded.tags) > 0 then excluded.tags else ${runs.tags} end`,
              error: sql`coalesce(excluded.error, ${runs.error})`,
              startedAt: sql`least(excluded.started_at, ${runs.startedAt})`,
              endedAt: sql`coalesce(excluded.ended_at, ${runs.endedAt})`,
            },
            where: sql`${runs.projectId} = ${projectId}`,
          });
      }

      // Steps whose run has not been seen yet get a stub run so nothing is lost;
      // the run upsert that follows fills it in.
      const missing = [...stepRunIds].filter((id) => !runIds.has(id));
      if (missing.length > 0) {
        const existing = await tx.select({ id: runs.id }).from(runs).where(inArray(runs.id, missing));
        const have = new Set(existing.map((r) => r.id));
        const stubs = missing.filter((id) => !have.has(id));
        if (stubs.length > 0) {
          const now = new Date();
          await tx
            .insert(runs)
            .values(
              stubs.map((id) => ({
                id,
                projectId,
                agent: "unknown",
                status: "running" as const,
                startedAt: now,
              })),
            )
            .onConflictDoNothing();
        }
      }

      if (payload.steps.length > 0) {
        await tx
          .insert(steps)
          .values(payload.steps.map((s) => toStepRow(projectId, s)))
          .onConflictDoUpdate({
            target: steps.id,
            set: {
              output: sql`coalesce(excluded.output, ${steps.output})`,
              input: sql`coalesce(excluded.input, ${steps.input})`,
              model: sql`coalesce(excluded.model, ${steps.model})`,
              provider: sql`coalesce(excluded.provider, ${steps.provider})`,
              params: sql`coalesce(excluded.params, ${steps.params})`,
              usage: sql`coalesce(excluded.usage, ${steps.usage})`,
              costUsd: sql`coalesce(excluded.cost_usd, ${steps.costUsd})`,
              latencyMs: sql`coalesce(excluded.latency_ms, ${steps.latencyMs})`,
              error: sql`coalesce(excluded.error, ${steps.error})`,
              sideEffect: sql`excluded.side_effect or ${steps.sideEffect}`,
              fingerprint: sql`coalesce(excluded.fingerprint, ${steps.fingerprint})`,
              endedAt: sql`coalesce(excluded.ended_at, ${steps.endedAt})`,
            },
            where: sql`${steps.projectId} = ${projectId}`,
          });
      }

      const touched = [...new Set([...runIds, ...stepRunIds])];
      if (touched.length > 0) {
        await tx.execute(sql`
          update runs r set
            step_count = s.n,
            cost_usd = s.cost
          from (
            select run_id, count(*)::int as n, sum(cost_usd) as cost
            from steps where run_id in ${touched}
            group by run_id
          ) s
          where r.id = s.run_id and r.project_id = ${projectId}
        `);
      }
    });

    this.logger.debug(`ingested ${payload.runs.length} runs, ${payload.steps.length} steps for ${projectId}`);
    return { runs: payload.runs.length, steps: payload.steps.length };
  }
}

function toRunRow(projectId: string, r: RunUpsert): typeof runs.$inferInsert {
  return {
    id: r.id,
    projectId,
    externalId: r.externalId ?? null,
    agent: r.agent,
    agentVersion: r.agentVersion ?? null,
    status: r.status,
    input: r.input ?? null,
    output: r.output ?? null,
    metadata: r.metadata ?? null,
    tags: r.tags ?? [],
    error: r.error ?? null,
    startedAt: new Date(r.startedAt),
    endedAt: r.endedAt ? new Date(r.endedAt) : null,
  };
}

function toStepRow(projectId: string, s: StepUpsert): typeof steps.$inferInsert {
  return {
    id: s.id,
    projectId,
    runId: s.runId,
    parentStepId: s.parentStepId ?? null,
    seq: s.seq,
    kind: s.kind,
    name: s.name,
    input: s.input ?? null,
    output: s.output ?? null,
    model: s.model ?? null,
    provider: s.provider ?? null,
    params: s.params ?? null,
    usage: s.usage ?? null,
    costUsd: s.costUsd ?? null,
    latencyMs: s.latencyMs ?? null,
    error: s.error ?? null,
    sideEffect: s.sideEffect ?? false,
    fingerprint: s.fingerprint ?? null,
    startedAt: new Date(s.startedAt),
    endedAt: s.endedAt ? new Date(s.endedAt) : null,
  };
}
