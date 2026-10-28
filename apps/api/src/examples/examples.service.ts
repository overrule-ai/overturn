import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Case, Example, ExamplesQuery, ExamplesResponse, ScorerContext } from "@overturn-ai/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { cases } from "../db/schema";
import { buildMessages } from "../replay/model-call";

const MAX_INPUT_CHARS = 4000;
const MAX_ANSWER_CHARS = 1500;

/** The text a case is retrieved by: its last user turn (the ticket, the question, the document). */
export function inputTextOf(c: Pick<Case, "frozenInput">): string {
  const messages = buildMessages(c.frozenInput);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (text.trim()) return text.slice(0, MAX_INPUT_CHARS);
  }
  return "";
}

function answerText(answer: unknown): string {
  const s = typeof answer === "string" ? answer : JSON.stringify(answer ?? null);
  return s.length > MAX_ANSWER_CHARS ? `${s.slice(0, MAX_ANSWER_CHARS - 1)}…` : s;
}

/**
 * Examples as a block for the system prompt. Plain and model-agnostic: "here is what a human
 * said was right for inputs like this one". Notes from reviewers are included — they are the
 * rule behind the correction.
 */
export function promptBlock(examples: Example[]): string {
  if (examples.length === 0) return "";
  const lines = [
    "",
    "## Examples reviewed by a human",
    "Inputs like the current one, with the answer a human reviewer approved or corrected. Follow them.",
    "",
  ];
  examples.forEach((e, i) => {
    lines.push(`### Example ${i + 1}`);
    lines.push(`Input: ${e.input}`);
    lines.push(`Correct answer: ${answerText(e.answer)}`);
    if (e.note) lines.push(`Reviewer's note: ${e.note}`);
    lines.push("");
  });
  return lines.join("\n");
}

@Injectable()
export class ExamplesService {
  private readonly logger = new Logger(ExamplesService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Cases that can serve as examples: active, with a human-approved answer. */
  private eligible(projectId: string) {
    return and(
      eq(cases.projectId, projectId),
      eq(cases.status, "active"),
      inArray(cases.kind, ["approve", "edit"]),
    );
  }

  /**
   * Embeds every eligible case that has no input embedding yet. Idempotent and incremental; a
   * new correction is embedded the first time examples are requested after it.
   */
  async ensureEmbedded(
    projectId: string,
    embed: NonNullable<ScorerContext["embed"]>,
    limit = 500,
  ): Promise<number> {
    const rows = await this.db
      .select({ id: cases.id, frozenInput: cases.frozenInput })
      .from(cases)
      .where(and(this.eligible(projectId), isNull(cases.inputEmbedding)))
      .limit(limit);
    let n = 0;
    for (const r of rows) {
      const text = inputTextOf({ frozenInput: r.frozenInput as Case["frozenInput"] });
      if (!text) {
        await this.db.update(cases).set({ inputText: "" }).where(eq(cases.id, r.id));
        continue;
      }
      try {
        const vec = await embed(text);
        await this.db.update(cases).set({ inputText: text, inputEmbedding: vec }).where(eq(cases.id, r.id));
        n++;
      } catch (err) {
        throw new Error(`embedding case ${r.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return n;
  }

  /** Makes sure every eligible case has its input text stored (no embedding needed). */
  async ensureInputText(projectId: string, limit = 2000): Promise<number> {
    const rows = await this.db
      .select({ id: cases.id, frozenInput: cases.frozenInput })
      .from(cases)
      .where(and(this.eligible(projectId), isNull(cases.inputText)))
      .limit(limit);
    for (const r of rows)
      await this.db
        .update(cases)
        .set({ inputText: inputTextOf({ frozenInput: r.frozenInput as Case["frozenInput"] }) })
        .where(eq(cases.id, r.id));
    return rows.length;
  }

  /**
   * Lexical retrieval when no embedding provider is configured: Postgres full-text ranking over
   * the case inputs. Weaker than embeddings on paraphrase, but it needs no key and no network.
   */
  async nearestLexical(
    projectId: string,
    input: string,
    q: { k: number; agent?: string; tag?: string; excludeCaseId?: string; excludeRunId?: string },
  ): Promise<Example[]> {
    const terms = [...new Set(input.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [])]
      .filter((t) => t.length > 2)
      .slice(0, 40);
    if (terms.length === 0) return [];
    const tsquery = terms
      .map((t) => t.replace(/[^a-z0-9]/g, ""))
      .filter(Boolean)
      .join(" | ");
    const conds = [
      this.eligible(projectId),
      sql`${cases.inputText} is not null and ${cases.inputText} <> ''`,
    ];
    if (q.agent) conds.push(eq(cases.agent, q.agent));
    if (q.tag) conds.push(sql`${q.tag} = any(${cases.tags})`);
    if (q.excludeCaseId) conds.push(sql`${cases.id} <> ${q.excludeCaseId}`);
    if (q.excludeRunId) conds.push(sql`${cases.runId} <> ${q.excludeRunId}`);
    const rank = sql<number>`ts_rank_cd(to_tsvector('english', ${cases.inputText}), to_tsquery('english', ${tsquery}))`;
    const rows = await this.db
      .select({
        id: cases.id,
        kind: cases.kind,
        inputText: cases.inputText,
        originalOutput: cases.originalOutput,
        expected: cases.expected,
        rank,
        note: sql<string | null>`(select note from corrections where corrections.id = ${cases.correctionId})`,
      })
      .from(cases)
      .where(and(...conds, sql`${rank} > 0`))
      .orderBy(sql`${rank} desc`)
      .limit(q.k);
    return rows.map((r) => ({
      caseId: r.id,
      kind: r.kind,
      input: r.inputText ?? "",
      answer: r.kind === "approve" ? (r.originalOutput ?? r.expected) : r.expected,
      note: r.note,
      similarity: Math.round(Math.min(1, Number(r.rank)) * 1000) / 1000,
    }));
  }

  /** Nearest eligible cases to a vector, by cosine distance; leave-one-out by case and by run. */
  async nearest(
    projectId: string,
    vector: number[],
    q: { k: number; agent?: string; tag?: string; excludeCaseId?: string; excludeRunId?: string },
  ): Promise<Example[]> {
    const conds = [this.eligible(projectId), sql`${cases.inputEmbedding} is not null`];
    if (q.agent) conds.push(eq(cases.agent, q.agent));
    if (q.tag) conds.push(sql`${q.tag} = any(${cases.tags})`);
    if (q.excludeCaseId) conds.push(sql`${cases.id} <> ${q.excludeCaseId}`);
    if (q.excludeRunId) conds.push(sql`${cases.runId} <> ${q.excludeRunId}`);
    const v = `[${vector.join(",")}]`;
    const rows = await this.db
      .select({
        id: cases.id,
        kind: cases.kind,
        inputText: cases.inputText,
        originalOutput: cases.originalOutput,
        expected: cases.expected,
        distance: sql<number>`${cases.inputEmbedding} <=> ${v}::vector`,
        note: sql<string | null>`(select note from corrections where corrections.id = ${cases.correctionId})`,
      })
      .from(cases)
      .where(and(...conds))
      .orderBy(sql`${cases.inputEmbedding} <=> ${v}::vector`)
      .limit(q.k);
    return rows.map((r) => ({
      caseId: r.id,
      kind: r.kind,
      input: r.inputText ?? "",
      answer: r.kind === "approve" ? (r.originalOutput ?? r.expected) : r.expected,
      note: r.note,
      similarity: Math.round((1 - Number(r.distance)) * 1000) / 1000,
    }));
  }

  /** Examples for an input, ready to put in a prompt. Lexical when there is no embedder. */
  async forInput(
    projectId: string,
    q: ExamplesQuery,
    ctx: { embed: NonNullable<ScorerContext["embed"]>; model: string } | null,
  ): Promise<ExamplesResponse> {
    const excludeRunId = q.excludeCaseId
      ? (
          await this.db
            .select({ runId: cases.runId })
            .from(cases)
            .where(eq(cases.id, q.excludeCaseId))
            .limit(1)
        )[0]?.runId
      : undefined;
    const sel = { k: q.k, agent: q.agent, tag: q.tag, excludeCaseId: q.excludeCaseId, excludeRunId };
    if (!ctx) {
      await this.ensureInputText(projectId);
      const examples = await this.nearestLexical(projectId, q.input, sel);
      return { examples, promptBlock: promptBlock(examples), embeddingModel: "lexical" };
    }
    try {
      await this.ensureEmbedded(projectId, ctx.embed);
      const vector = await ctx.embed(q.input.slice(0, MAX_INPUT_CHARS));
      const examples = await this.nearest(projectId, vector, sel);
      return { examples, promptBlock: promptBlock(examples), embeddingModel: ctx.model };
    } catch (err) {
      // a configured provider that refuses (model not serverless, quota) must not take examples down
      this.logger.warn(
        `embeddings unavailable (${err instanceof Error ? err.message : String(err)}); using lexical retrieval`,
      );
      await this.ensureInputText(projectId);
      const examples = await this.nearestLexical(projectId, q.input, sel);
      return { examples, promptBlock: promptBlock(examples), embeddingModel: "lexical" };
    }
  }
}
