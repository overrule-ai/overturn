import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  type Correction,
  type CorrectionCreate,
  type CorrectionResult,
  defaultScorer,
  expectedFor,
  extractAnswer,
  type FrozenInput,
  type ToolRecordingEntry,
} from "@overturn-ai/shared";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { CasesService } from "../cases/cases.service";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { type CorrectionRow, cases, corrections, runs, type StepRow, steps } from "../db/schema";

/** Size caps for what a case freezes (decision: docs/decisions.md). */
export const FROZEN_INPUT_MAX_BYTES = 1_000_000;
export const RECORDING_OUTPUT_MAX_BYTES = 256_000;

export function serializeCorrection(r: CorrectionRow): Correction {
  return {
    id: r.id,
    projectId: r.projectId,
    runId: r.runId,
    stepId: r.stepId,
    kind: r.kind,
    correctedOutput: r.correctedOutput,
    note: r.note,
    actor: r.actor,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  };
}

function byteSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? "");
}

/** Keeps the system prompt and the most recent messages until the input fits the cap. */
export function truncateFrozenInput(input: FrozenInput): { input: FrozenInput; truncated: boolean } {
  if (byteSize(input) <= FROZEN_INPUT_MAX_BYTES) return { input, truncated: false };
  const messages = Array.isArray(input.messages) ? [...(input.messages as unknown[])] : null;
  if (!messages || messages.length < 3) {
    return {
      input: { ...input, messages: messages ? messages.slice(-1) : input.messages, _truncated: true },
      truncated: true,
    };
  }
  const head = messages[0];
  let tail = messages.slice(1);
  while (tail.length > 1 && byteSize({ ...input, messages: [head, ...tail] }) > FROZEN_INPUT_MAX_BYTES)
    tail = tail.slice(1);
  return {
    input: {
      ...input,
      messages: [
        head,
        {
          role: "system",
          content: `[overturn: ${messages.length - 1 - tail.length} earlier messages dropped to fit the case size cap]`,
        },
        ...tail,
      ],
      _truncated: true,
    },
    truncated: true,
  };
}

export function truncateRecording(rec: ToolRecordingEntry): ToolRecordingEntry {
  if (byteSize(rec.output) <= RECORDING_OUTPUT_MAX_BYTES) return rec;
  const text = JSON.stringify(rec.output).slice(0, RECORDING_OUTPUT_MAX_BYTES);
  return { ...rec, output: text, truncated: true };
}

@Injectable()
export class CorrectionsService {
  private readonly logger = new Logger(CorrectionsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly casesService: CasesService,
  ) {}

  async list(projectId: string, q: { runId?: string; limit: number }): Promise<Correction[]> {
    const where = [eq(corrections.projectId, projectId)];
    if (q.runId) where.push(eq(corrections.runId, q.runId));
    const rows = await this.db
      .select()
      .from(corrections)
      .where(and(...where))
      .orderBy(desc(corrections.createdAt))
      .limit(q.limit);
    return rows.map(serializeCorrection);
  }

  /** Records a correction and freezes a case from it, in one transaction. */
  async create(projectId: string, input: CorrectionCreate): Promise<CorrectionResult> {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, projectId), eq(runs.id, input.runId)))
      .limit(1);
    if (!run) throw new NotFoundException(`Run ${input.runId} not found`);
    if (input.kind === "edit" && input.correctedOutput === undefined) {
      throw new BadRequestException("An edit correction needs correctedOutput");
    }

    const runSteps = await this.db
      .select()
      .from(steps)
      .where(eq(steps.runId, run.id))
      .orderBy(asc(steps.seq));
    let step: StepRow | null = null;
    if (input.stepId) {
      step = runSteps.find((s) => s.id === input.stepId) ?? null;
      if (!step) throw new NotFoundException(`Step ${input.stepId} not found on run ${run.id}`);
      if (step.kind !== "llm_call")
        throw new BadRequestException("Corrections attach to llm_call steps or to the run");
    } else {
      // run-level: the decision is the last llm_call step
      step = [...runSteps].reverse().find((s) => s.kind === "llm_call") ?? null;
    }

    const correctionId = uuidv7();
    const result: { correction: Correction; caseId: string | null } = await this.db.transaction(
      async (tx) => {
        const [corr] = await tx
          .insert(corrections)
          .values({
            id: correctionId,
            projectId,
            runId: run.id,
            stepId: input.stepId ?? null,
            kind: input.kind,
            correctedOutput: input.correctedOutput ?? null,
            note: input.note ?? null,
            actor: input.actor ?? null,
            source: input.source,
          })
          .returning();
        await tx
          .update(runs)
          .set({ correctionCount: sql`${runs.correctionCount} + 1` })
          .where(eq(runs.id, run.id));

        if (!step) {
          this.logger.warn(
            `run ${run.id} has no llm_call step; correction ${correctionId} recorded without a case`,
          );
          return { correction: serializeCorrection(corr!), caseId: null };
        }

        const stepInput = (step.input ?? {}) as Record<string, unknown>;
        const frozen = truncateFrozenInput({
          name: step.name,
          provider: step.provider,
          model: step.model,
          ...stepInput,
          params: (step.params ?? null) as FrozenInput["params"],
        });

        const recordings: Record<string, ToolRecordingEntry> = {};
        for (const s of runSteps) {
          if (s.kind !== "tool_call" || !s.fingerprint) continue;
          recordings[s.fingerprint] = truncateRecording({
            name: s.name,
            args: s.input,
            output: s.output,
            sideEffect: s.sideEffect,
          });
        }

        // Original answer: the step's answer for step-level corrections; the run output for run-level
        // when present (same thing in a well-formed run, but the run output is what the human saw).
        const originalAnswer = input.stepId
          ? extractAnswer(step.output)
          : (run.output ?? extractAnswer(step.output));
        const expected = expectedFor(input.kind, originalAnswer, input.correctedOutput, input.note ?? null);
        const { scorer, config } = defaultScorer(input.kind, expected, input.note ?? null);
        const title = `${input.kind}: ${run.agent} ${run.externalId ?? run.id.slice(-8)}${input.note ? ` — ${input.note.slice(0, 80)}` : ""}`;

        const [c] = await tx
          .insert(cases)
          .values({
            id: uuidv7(),
            projectId,
            correctionId,
            runId: run.id,
            stepId: step.id,
            agent: run.agent,
            agentVersion: run.agentVersion,
            kind: input.kind,
            title,
            frozenInput: frozen.input,
            toolRecordings: recordings,
            originalOutput: originalAnswer,
            expected,
            scorer,
            scorerConfig: config,
            tags: run.tags,
            truncated: frozen.truncated,
            recordedModel: step.model,
          })
          .returning();
        return { correction: serializeCorrection(corr!), caseId: c!.id };
      },
    );

    return {
      correction: result.correction,
      case: result.caseId ? await this.casesService.get(projectId, result.caseId) : null,
    };
  }

  /**
   * Implicit approval: runs completed more than `implicitApproveAfterDays` ago with no
   * correction get an approve correction (source "implicit"), so case sets are not all negatives.
   */
  async sweepImplicitApprovals(projectId: string, days: number, limit = 500): Promise<number> {
    if (days <= 0) return 0;
    const before = new Date(Date.now() - days * 86_400_000);
    const candidates = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.status, "completed"),
          eq(runs.correctionCount, 0),
          lt(runs.endedAt, before),
        ),
      )
      .limit(limit);
    let n = 0;
    for (const { id } of candidates) {
      try {
        await this.create(projectId, {
          runId: id,
          kind: "approve",
          source: "implicit",
          actor: "system",
          note: `implicitly approved after ${days} days`,
        });
        n++;
      } catch (err) {
        this.logger.warn(
          `implicit approve failed for run ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return n;
  }
}
