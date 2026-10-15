import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// pgvector column (dimension fixed per embedding model; 1536 fits text-embedding-3-small)
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(",")
      .map((v) => Number.parseFloat(v));
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
};

export const stepKind = pgEnum("step_kind", ["llm_call", "tool_call", "retrieval", "human"]);
export const runStatus = pgEnum("run_status", ["running", "completed", "failed"]);
export const correctionKind = pgEnum("correction_kind", ["approve", "edit", "reject", "escalate"]);
export const correctionSource = pgEnum("correction_source", ["sdk", "ui", "api", "implicit"]);
export const caseStatus = pgEnum("case_status", ["active", "archived"]);
export const replayMode = pgEnum("replay_mode", ["step", "trajectory"]);
export const replayStatus = pgEnum("replay_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const verdict = pgEnum("verdict", [
  "pass",
  "fail",
  "regression",
  "fixed",
  "unchanged",
  "unreplayable",
  "error",
]);

// ---------- tenancy ----------

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  ...timestamps,
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    ...timestamps,
  },
  (t) => [uniqueIndex("memberships_org_user").on(t.organizationId, t.userId)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (t) => [uniqueIndex("projects_org_slug").on(t.organizationId, t.slug)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("default"),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [index("api_keys_project").on(t.projectId)],
);

// ---------- recording ----------

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    agent: text("agent").notNull(),
    agentVersion: text("agent_version"),
    status: runStatus("status").notNull().default("running"),
    input: jsonb("input"),
    output: jsonb("output"),
    metadata: jsonb("metadata"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    /** Denormalized for list views; maintained by ingest and corrections. */
    stepCount: integer("step_count").notNull().default(0),
    correctionCount: integer("correction_count").notNull().default(0),
    costUsd: doublePrecision("cost_usd"),
    ...timestamps,
  },
  (t) => [
    index("runs_project_started").on(t.projectId, t.startedAt),
    index("runs_project_agent").on(t.projectId, t.agent),
    index("runs_tags").using("gin", t.tags),
  ],
);

export const steps = pgTable(
  "steps",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    parentStepId: uuid("parent_step_id"),
    /** Order within the run. SDKs count from 0; OTLP uses the span start time in microseconds. */
    seq: bigint("seq", { mode: "number" }).notNull(),
    kind: stepKind("kind").notNull(),
    name: text("name").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    model: text("model"),
    provider: text("provider"),
    params: jsonb("params"),
    usage: jsonb("usage"),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: doublePrecision("latency_ms"),
    error: text("error"),
    sideEffect: boolean("side_effect").notNull().default(false),
    fingerprint: text("fingerprint"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [
    index("steps_run_seq").on(t.runId, t.seq),
    index("steps_fingerprint").on(t.projectId, t.fingerprint),
  ],
);

// ---------- corrections and cases ----------

export const corrections = pgTable(
  "corrections",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => steps.id, { onDelete: "cascade" }),
    kind: correctionKind("kind").notNull(),
    correctedOutput: jsonb("corrected_output"),
    note: text("note"),
    actor: text("actor"),
    source: correctionSource("source").notNull(),
    ...timestamps,
  },
  (t) => [
    index("corrections_run").on(t.runId),
    index("corrections_project_created").on(t.projectId, t.createdAt),
  ],
);

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    correctionId: uuid("correction_id")
      .notNull()
      .references(() => corrections.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => steps.id, { onDelete: "set null" }),
    agent: text("agent").notNull(),
    agentVersion: text("agent_version"),
    kind: correctionKind("kind").notNull(),
    title: text("title").notNull(),
    /** The step's exact input: messages, tool schemas, params, model. */
    frozenInput: jsonb("frozen_input").notNull(),
    /** fingerprint -> { name, args, output } for every tool call in the run. */
    toolRecordings: jsonb("tool_recordings").notNull().default(sql`'{}'::jsonb`),
    originalOutput: jsonb("original_output"),
    expected: jsonb("expected"),
    scorer: text("scorer").notNull(),
    scorerConfig: jsonb("scorer_config").notNull().default(sql`'{}'::jsonb`),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    status: caseStatus("status").notNull().default("active"),
    truncated: boolean("truncated").notNull().default(false),
    /** Model the run was recorded with; baseline for verdicts. */
    recordedModel: text("recorded_model"),
    lastVerdict: verdict("last_verdict"),
    expectedEmbedding: vector("expected_embedding"),
    ...timestamps,
  },
  (t) => [
    index("cases_project_created").on(t.projectId, t.createdAt),
    index("cases_project_agent").on(t.projectId, t.agent),
    index("cases_tags").using("gin", t.tags),
    uniqueIndex("cases_correction").on(t.correctionId),
  ],
);

export const caseSets = pgTable("case_sets", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  filter: jsonb("filter").notNull().default(sql`'{}'::jsonb`),
  ...timestamps,
});

// ---------- replay ----------

export const replayJobs = pgTable(
  "replay_jobs",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetModel: text("target_model").notNull(),
    targetPromptVersion: text("target_prompt_version"),
    mode: replayMode("mode").notNull().default("step"),
    caseFilter: jsonb("case_filter").notNull().default(sql`'{}'::jsonb`),
    status: replayStatus("status").notNull().default("pending"),
    summary: jsonb("summary"),
    estimatedCostUsd: doublePrecision("estimated_cost_usd"),
    maxCostUsd: doublePrecision("max_cost_usd"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    caseCount: integer("case_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [index("replay_jobs_project_created").on(t.projectId, t.createdAt)],
);

export const replayResults = pgTable(
  "replay_results",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => replayJobs.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    output: jsonb("output"),
    score: doublePrecision("score"),
    passed: boolean("passed"),
    verdict: verdict("verdict").notNull(),
    reason: text("reason"),
    latencyMs: doublePrecision("latency_ms"),
    costUsd: doublePrecision("cost_usd"),
    diff: jsonb("diff"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("replay_results_job_case").on(t.jobId, t.caseId),
    index("replay_results_case").on(t.caseId),
  ],
);

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: text("version").notNull(),
    template: text("template").notNull(),
    hash: text("hash").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("prompt_versions_name_version").on(t.projectId, t.name, t.version)],
);

/** Cached model responses for replay: (model, input hash) -> output, 24h TTL. */
export const responseCache = pgTable(
  "response_cache",
  {
    key: text("key").primaryKey(),
    model: text("model").notNull(),
    output: jsonb("output").notNull(),
    usage: jsonb("usage"),
    costUsd: doublePrecision("cost_usd"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    ...timestamps,
  },
  (t) => [index("response_cache_expires").on(t.expiresAt)],
);

// ---------- web auth (M6) ----------

export const magicLinks = pgTable("magic_links", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  ...timestamps,
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  ...timestamps,
});

export type RunRow = typeof runs.$inferSelect;
export type StepRow = typeof steps.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type CorrectionRow = typeof corrections.$inferSelect;
export type CaseRow = typeof cases.$inferSelect;
export type ReplayJobRow = typeof replayJobs.$inferSelect;
export type ReplayResultRow = typeof replayResults.$inferSelect;
