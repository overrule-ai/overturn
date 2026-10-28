import { z } from "zod";

// ---------- primitives ----------

export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const uuidSchema = z.uuid();
export const isoDateSchema = z.iso.datetime({ offset: true });

export const stepKindSchema = z.enum(["llm_call", "tool_call", "retrieval", "human"]);
export type StepKind = z.infer<typeof stepKindSchema>;

export const runStatusSchema = z.enum(["running", "completed", "failed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const correctionKindSchema = z.enum(["approve", "edit", "reject", "escalate"]);
export type CorrectionKind = z.infer<typeof correctionKindSchema>;

export const correctionSourceSchema = z.enum(["sdk", "ui", "api", "implicit"]);
export type CorrectionSource = z.infer<typeof correctionSourceSchema>;

export const scorerNameSchema = z.enum([
  "equals",
  "json_match",
  "tool_choice",
  "semantic",
  "judge",
  "not_equals",
  "should_escalate",
]);
export type ScorerName = z.infer<typeof scorerNameSchema>;

export const verdictSchema = z.enum([
  "pass",
  "fail",
  "regression",
  "fixed",
  "unchanged",
  "unreplayable",
  /** Trajectory mode: the agent called a tool with no recording. Needs a human to accept the path or not. */
  "new_path",
  "error",
]);
export type Verdict = z.infer<typeof verdictSchema>;

export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    firstTokenMs: z.number().nonnegative().optional(),
  })
  .loose();
export type Usage = z.infer<typeof usageSchema>;

// ---------- ingest payload, v1 ----------

export const INGEST_VERSION = 1 as const;

export const runUpsertSchema = z.object({
  id: uuidSchema,
  externalId: z.string().max(512).nullish(),
  agent: z.string().min(1).max(200),
  agentVersion: z.string().max(100).nullish(),
  status: runStatusSchema,
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  metadata: z.record(z.string(), jsonValueSchema).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  startedAt: isoDateSchema,
  endedAt: isoDateSchema.nullish(),
  error: z.string().max(10_000).nullish(),
});
export type RunUpsert = z.infer<typeof runUpsertSchema>;

export const stepUpsertSchema = z.object({
  id: uuidSchema,
  runId: uuidSchema,
  parentStepId: uuidSchema.nullish(),
  seq: z.number().int().nonnegative(),
  kind: stepKindSchema,
  name: z.string().min(1).max(200),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  model: z.string().max(200).nullish(),
  provider: z.string().max(100).nullish(),
  params: z.record(z.string(), jsonValueSchema).optional(),
  usage: usageSchema.optional(),
  costUsd: z.number().nonnegative().nullish(),
  latencyMs: z.number().nonnegative().nullish(),
  error: z.string().max(10_000).nullish(),
  sideEffect: z.boolean().optional(),
  /** Tool-call fingerprint, computed client-side by the SDK with the tool's matchOn/ignoreArgs. */
  fingerprint: z.string().length(64).nullish(),
  startedAt: isoDateSchema,
  endedAt: isoDateSchema.nullish(),
});
export type StepUpsert = z.infer<typeof stepUpsertSchema>;

export const ingestPayloadSchema = z.object({
  v: z.literal(INGEST_VERSION),
  runs: z.array(runUpsertSchema).max(500).default([]),
  steps: z.array(stepUpsertSchema).max(2000).default([]),
});
export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

export const ingestResponseSchema = z.object({
  runs: z.number().int(),
  steps: z.number().int(),
});
export type IngestResponse = z.infer<typeof ingestResponseSchema>;

// ---------- read models ----------

export const runSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  externalId: z.string().nullable(),
  agent: z.string(),
  agentVersion: z.string().nullable(),
  status: runStatusSchema,
  input: jsonValueSchema.nullable(),
  output: jsonValueSchema.nullable(),
  metadata: z.record(z.string(), jsonValueSchema).nullable(),
  tags: z.array(z.string()),
  startedAt: isoDateSchema,
  endedAt: isoDateSchema.nullable(),
  error: z.string().nullable(),
  stepCount: z.number().int(),
  correctionCount: z.number().int(),
  costUsd: z.number().nullable(),
  createdAt: isoDateSchema,
});
export type Run = z.infer<typeof runSchema>;

export const stepSchema = z.object({
  id: uuidSchema,
  runId: uuidSchema,
  parentStepId: uuidSchema.nullable(),
  seq: z.number().int(),
  kind: stepKindSchema,
  name: z.string(),
  input: jsonValueSchema.nullable(),
  output: jsonValueSchema.nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  params: z.record(z.string(), jsonValueSchema).nullable(),
  usage: usageSchema.nullable(),
  costUsd: z.number().nullable(),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
  sideEffect: z.boolean(),
  fingerprint: z.string().nullable(),
  startedAt: isoDateSchema,
  endedAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
});
export type Step = z.infer<typeof stepSchema>;

export const runWithStepsSchema = runSchema.extend({ steps: z.array(stepSchema) });
export type RunWithSteps = z.infer<typeof runWithStepsSchema>;

export const runListQuerySchema = z.object({
  agent: z.string().optional(),
  tag: z.string().optional(),
  status: runStatusSchema.optional(),
  corrected: z.enum(["true", "false"]).optional(),
  since: isoDateSchema.optional(),
  until: isoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type RunListQuery = z.infer<typeof runListQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const meResponseSchema = z.object({
  project: z.object({ id: uuidSchema, name: z.string(), slug: z.string() }),
  organization: z.object({ id: uuidSchema, name: z.string() }),
  keyPrefix: z.string(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
  details: jsonValueSchema.optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// ---------- project settings ----------

export const projectSettingsSchema = z.object({
  defaultScorer: scorerNameSchema.nullable().default(null),
  judgeModel: z.string().default("openai/gpt-4.1-mini"),
  embeddingModel: z.string().default("openai/text-embedding-3-small"),
  implicitApproveAfterDays: z.number().int().min(0).max(365).default(0),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  /** Slack incoming-webhook URL; every completed run is posted there with Review / Approve buttons. */
  reviewWebhookUrl: z.string().url().max(2000).nullable().default(null),
  /** A replay with new paths (tool calls with no recording) fails the CI gate until a human accepts them. */
  newPathsBlock: z.boolean().default(true),
  /** The owned model a human promoted (provider/model); what `ov.promotedModel()` returns. Null = none. */
  promotedModel: z.string().nullable().default(null),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

// ---------- examples (corrections in the prompt) ----------

export const examplesQuerySchema = z.object({
  /** The input to find examples for: the user's message, the ticket, the document. */
  input: z.string().min(1).max(20_000),
  k: z.coerce.number().int().min(1).max(20).default(5),
  agent: z.string().optional(),
  tag: z.string().optional(),
  /** Leave-one-out: never return this case or anything from its run. */
  excludeCaseId: uuidSchema.optional(),
});
export type ExamplesQuery = z.infer<typeof examplesQuerySchema>;

export const exampleSchema = z.object({
  caseId: uuidSchema,
  kind: correctionKindSchema,
  input: z.string(),
  answer: jsonValueSchema,
  note: z.string().nullable(),
  similarity: z.number(),
});
export type Example = z.infer<typeof exampleSchema>;

export const examplesResponseSchema = z.object({
  examples: z.array(exampleSchema),
  /** Ready to append to a system prompt. */
  promptBlock: z.string(),
  embeddingModel: z.string(),
});
export type ExamplesResponse = z.infer<typeof examplesResponseSchema>;

// ---------- export (fine-tuning datasets) ----------

export const exportFormatSchema = z.enum(["sft", "dpo"]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const exportQuerySchema = z.object({
  format: exportFormatSchema.default("sft"),
  agent: z.string().optional(),
  tag: z.string().optional(),
  set: z.string().optional(),
  since: z.string().optional(),
  /** Include approved cases as positive examples (sft only). */
  includeApproved: z.coerce.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(50_000).default(50_000),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

/** What an export would contain, before downloading it. */
export const exportStatsSchema = z.object({
  format: exportFormatSchema,
  rows: z.number().int(),
  skipped: z.number().int(),
  byKind: z.record(z.string(), z.number().int()),
  /** Rough token count of the dataset (chars / 4). */
  approxTokens: z.number().int(),
});
export type ExportStats = z.infer<typeof exportStatsSchema>;

// ---------- outcome contract ----------

/**
 * A few hard rules a human attaches to a case at correction time. Evaluated after the
 * scorer on every replay; a violation fails the case (and is a regression when the
 * baseline passed). Kept deliberately small: the power is in the one or two rules a
 * reviewer actually cares about.
 */
export const contractRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_called"),
    tool: z.string().min(1).max(200),
    count: z.enum(["once", "at_least_once", "never"]).default("at_least_once"),
  }),
  z.object({
    type: z.literal("answer"),
    contains: z.string().min(1).max(2000),
    negate: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("tool_order"),
    first: z.string().min(1).max(200),
    second: z.string().min(1).max(200),
  }),
]);
export type ContractRule = z.infer<typeof contractRuleSchema>;
export const contractSchema = z.array(contractRuleSchema).max(8);
export type Contract = z.infer<typeof contractSchema>;

// ---------- corrections ----------

export const correctionCreateSchema = z.object({
  runId: uuidSchema,
  stepId: uuidSchema.nullish(),
  kind: correctionKindSchema,
  correctedOutput: jsonValueSchema.optional(),
  note: z.string().max(10_000).nullish(),
  actor: z.string().max(200).nullish(),
  source: correctionSourceSchema.default("api"),
  /** Override the scorer the case gets; omitted = chosen from the shape of the expected answer. */
  scorer: scorerNameSchema.optional(),
  scorerConfig: z.record(z.string(), jsonValueSchema).optional(),
  /** Hard rules for the case this correction creates (see contractRuleSchema). */
  contract: contractSchema.optional(),
});
export type CorrectionCreate = z.infer<typeof correctionCreateSchema>;

export const correctionSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  runId: uuidSchema,
  stepId: uuidSchema.nullable(),
  kind: correctionKindSchema,
  correctedOutput: jsonValueSchema.nullable(),
  note: z.string().nullable(),
  actor: z.string().nullable(),
  source: correctionSourceSchema,
  createdAt: isoDateSchema,
});
export type Correction = z.infer<typeof correctionSchema>;

export const correctionListQuerySchema = z.object({
  runId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------- cases ----------

/** suppressed: taken out of the default suite by a human from a report; restorable. */
export const caseStatusSchema = z.enum(["active", "archived", "suppressed"]);
export type CaseStatus = z.infer<typeof caseStatusSchema>;

/** What a case freezes from the corrected llm_call step. */
export const frozenInputSchema = z
  .object({
    name: z.string(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    messages: jsonValueSchema.optional(),
    tools: jsonValueSchema.optional(),
    tool_choice: jsonValueSchema.optional(),
    response_format: jsonValueSchema.optional(),
    system: jsonValueSchema.optional(),
    params: z.record(z.string(), jsonValueSchema).nullable(),
  })
  .loose();
export type FrozenInput = z.infer<typeof frozenInputSchema>;

export const toolRecordingSchema = z.object({
  name: z.string(),
  args: jsonValueSchema,
  output: jsonValueSchema,
  sideEffect: z.boolean().default(false),
  truncated: z.boolean().optional(),
  /** Set when a human accepted this call as equivalent to a recorded one (its fingerprint). */
  equivalentOf: z.string().optional(),
  note: z.string().max(2000).nullish(),
  acceptedAt: isoDateSchema.optional(),
  acceptedBy: z.string().max(200).nullish(),
});
export type ToolRecordingEntry = z.infer<typeof toolRecordingSchema>;
export const toolRecordingsSchema = z.record(z.string(), toolRecordingSchema);

export const caseSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  correctionId: uuidSchema,
  runId: uuidSchema,
  stepId: uuidSchema.nullable(),
  agent: z.string(),
  agentVersion: z.string().nullable(),
  kind: correctionKindSchema,
  title: z.string(),
  frozenInput: frozenInputSchema,
  toolRecordings: toolRecordingsSchema,
  originalOutput: jsonValueSchema.nullable(),
  expected: jsonValueSchema.nullable(),
  scorer: scorerNameSchema,
  scorerConfig: z.record(z.string(), jsonValueSchema),
  tags: z.array(z.string()),
  status: caseStatusSchema,
  truncated: z.boolean(),
  contract: contractSchema,
  recordedModel: z.string().nullable(),
  lastVerdict: verdictSchema.nullable(),
  note: z.string().nullable(),
  actor: z.string().nullable(),
  createdAt: isoDateSchema,
});
export type Case = z.infer<typeof caseSchema>;

/** Lightweight list row: no frozen input or recordings. */
export const caseSummarySchema = caseSchema.omit({ frozenInput: true, toolRecordings: true });
export type CaseSummary = z.infer<typeof caseSummarySchema>;

export const caseFilterSchema = z.object({
  agent: z.string().optional(),
  tag: z.string().optional(),
  kind: correctionKindSchema.optional(),
  status: caseStatusSchema.default("active"),
  since: isoDateSchema.optional(),
  until: isoDateSchema.optional(),
  ids: z.array(uuidSchema).optional(),
  /** Name or id of a saved case set; its filter is merged in. */
  set: z.string().optional(),
});
export type CaseFilter = z.infer<typeof caseFilterSchema>;

export const caseListQuerySchema = caseFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export type CaseListQuery = z.infer<typeof caseListQuerySchema>;

export const casePatchSchema = z.object({
  status: caseStatusSchema.optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  title: z.string().max(500).optional(),
  scorer: scorerNameSchema.optional(),
  scorerConfig: z.record(z.string(), jsonValueSchema).optional(),
  expected: jsonValueSchema.optional(),
  contract: contractSchema.optional(),
});
export type CasePatch = z.infer<typeof casePatchSchema>;

/** Accept a tool call the agent made during replay as equivalent to a recorded one. */
export const caseEquivalentSchema = z.object({
  toolName: z.string().min(1).max(200),
  args: jsonValueSchema,
  /** Fingerprint of the recorded call whose output answers this one. */
  equivalentOf: z.string().min(1),
  note: z.string().max(2000).nullish(),
  actor: z.string().max(200).nullish(),
  /** The replay result this came from; its verdict is re-evaluated under the human's original decision. */
  jobId: uuidSchema.optional(),
});
export type CaseEquivalent = z.infer<typeof caseEquivalentSchema>;

export const caseCountsSchema = z.object({
  active: z.number().int(),
  suppressed: z.number().int(),
  archived: z.number().int(),
});
export type CaseCounts = z.infer<typeof caseCountsSchema>;

export const caseSetCreateSchema = z.object({
  name: z.string().min(1).max(200),
  filter: caseFilterSchema.omit({ set: true }).partial(),
});
export type CaseSetCreate = z.infer<typeof caseSetCreateSchema>;

export const caseSetSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  name: z.string(),
  filter: jsonValueSchema,
  createdAt: isoDateSchema,
});
export type CaseSet = z.infer<typeof caseSetSchema>;

export const correctionResultSchema = z.object({
  correction: correctionSchema,
  case: caseSchema.nullable(),
});
export type CorrectionResult = z.infer<typeof correctionResultSchema>;

// ---------- project ----------

export const projectSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  slug: z.string(),
  settings: projectSettingsSchema,
  createdAt: isoDateSchema,
});
export type Project = z.infer<typeof projectSchema>;

export const projectPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  settings: projectSettingsSchema.partial().optional(),
});
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

// ---------- replay ----------

export const replayModeSchema = z.enum(["step", "trajectory"]);
export type ReplayMode = z.infer<typeof replayModeSchema>;
export const replayStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
export type ReplayStatus = z.infer<typeof replayStatusSchema>;

const modelIdSchema = z.string().regex(/^[a-z0-9_-]+\/.+$/i, "model must be provider/model");

export const replayCreateSchema = z.object({
  /** provider/model, e.g. openai/gpt-4.1-mini, anthropic/claude-sonnet-4-5, fake/fake-triage-weak */
  model: modelIdSchema,
  /** More models to replay the same cases against, as one group (a case × model matrix). */
  models: z.array(modelIdSchema).max(8).optional(),
  mode: replayModeSchema.default("step"),
  /** name@version of a registered prompt; replaces the system prompt in step mode */
  promptVersion: z.string().max(200).nullish(),
  filter: caseFilterSchema.partial().default({}),
  maxCostUsd: z.number().positive().nullish(),
  /** Start the job immediately (default) or just create it (trajectory mode posts results itself). */
  start: z.boolean().default(true),
  /**
   * Corrections in the prompt: put the k nearest human-approved cases (by input similarity,
   * never the case itself or its run) into the system prompt as examples. Step mode only.
   */
  examples: z.number().int().min(0).max(20).default(0),
});
export type ReplayCreate = z.infer<typeof replayCreateSchema>;

export const replayEstimateSchema = z.object({
  cases: z.number().int(),
  estimatedCostUsd: z.number().nullable(),
  estimatedInputTokens: z.number().int(),
  estimatedOutputTokens: z.number().int(),
  priced: z.boolean(),
});
export type ReplayEstimate = z.infer<typeof replayEstimateSchema>;

export const replaySummarySchema = z.object({
  cases: z.number().int(),
  completed: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  passRate: z.number(),
  verdicts: z.record(verdictSchema, z.number().int()),
  costUsd: z.number(),
  durationMs: z.number().nullable(),
  baseline: z
    .object({ kind: z.enum(["job", "recorded"]), jobId: uuidSchema.nullable(), model: z.string().nullable() })
    .nullable(),
  stoppedByCostCap: z.boolean().default(false),
  /** Median model-call latency across cases, when results carry it. */
  latencyP50Ms: z.number().nullable().optional(),
  /** Spend divided by cases that ran (null when the model is unpriced). */
  costPerCallUsd: z.number().nullable().optional(),
});
export type ReplaySummary = z.infer<typeof replaySummarySchema>;

export const replayOptionsSchema = z.object({
  examples: z.number().int().min(0).max(20).default(0),
});
export type ReplayOptions = z.infer<typeof replayOptionsSchema>;

export const replayJobSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  targetModel: z.string(),
  targetPromptVersion: z.string().nullable(),
  options: replayOptionsSchema.default({ examples: 0 }),
  /** Set when several models were replayed together; GET /v1/replays/groups/{groupId} is the matrix. */
  groupId: uuidSchema.nullable(),
  mode: replayModeSchema,
  caseFilter: jsonValueSchema,
  status: replayStatusSchema,
  summary: replaySummarySchema.nullable(),
  estimatedCostUsd: z.number().nullable(),
  maxCostUsd: z.number().nullable(),
  costUsd: z.number(),
  caseCount: z.number().int(),
  completedCount: z.number().int(),
  error: z.string().nullable(),
  startedAt: isoDateSchema.nullable(),
  finishedAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
});
export type ReplayJob = z.infer<typeof replayJobSchema>;

export const replayMatrixCellSchema = z.object({
  verdict: verdictSchema.nullable(),
  passed: z.boolean().nullable(),
  score: z.number().nullable(),
  reason: z.string().nullable(),
});
/** One row of the challenger scorecard: a model against the incumbent on the same cases. */
export const scorecardRowSchema = z.object({
  jobId: uuidSchema,
  model: z.string(),
  incumbent: z.boolean(),
  status: replayStatusSchema,
  passRate: z.number().nullable(),
  regressions: z.number().int(),
  costPerCallUsd: z.number().nullable(),
  latencyP50Ms: z.number().nullable(),
  /** USD per 1M tokens [input, output], when known. */
  pricePerMTokens: z.tuple([z.number(), z.number()]).nullable(),
  /** Relative to the incumbent: pass-rate points and cost ratio (0.25 = a quarter of the cost). */
  vsIncumbent: z
    .object({ passRatePoints: z.number().nullable(), costRatio: z.number().nullable() })
    .nullable(),
});
export type ScorecardRow = z.infer<typeof scorecardRowSchema>;

/** One replay across several models: cases as rows, jobs (models) as columns. */
export const replayMatrixSchema = z.object({
  groupId: uuidSchema,
  jobs: z.array(replayJobSchema),
  /** The same jobs as a scorecard against the incumbent (the model the cases were recorded with, else the first job). */
  scorecard: z.array(scorecardRowSchema).optional(),
  cases: z.array(
    z.object({
      caseId: uuidSchema,
      title: z.string(),
      kind: correctionKindSchema,
      agent: z.string(),
      /** keyed by job id */
      cells: z.record(z.string(), replayMatrixCellSchema),
    }),
  ),
});
export type ReplayMatrix = z.infer<typeof replayMatrixSchema>;
export type ReplayMatrixCell = z.infer<typeof replayMatrixCellSchema>;

export const replayResultSchema = z.object({
  id: uuidSchema,
  jobId: uuidSchema,
  caseId: uuidSchema,
  output: jsonValueSchema.nullable(),
  score: z.number().nullable(),
  passed: z.boolean().nullable(),
  verdict: verdictSchema,
  reason: z.string().nullable(),
  latencyMs: z.number().nullable(),
  costUsd: z.number().nullable(),
  diff: jsonValueSchema.nullable(),
  error: z.string().nullable(),
  createdAt: isoDateSchema,
});
export type ReplayResult = z.infer<typeof replayResultSchema>;

/** A result the trajectory runner (CLI) posts back. */
export const replayResultPostSchema = z.object({
  caseId: uuidSchema,
  output: jsonValueSchema.optional(),
  latencyMs: z.number().nonnegative().nullish(),
  costUsd: z.number().nonnegative().nullish(),
  error: z.string().max(10_000).nullish(),
  /** Set when the agent hit a tool call with no recording or a refused side-effect tool. */
  unreplayable: z
    .object({ toolName: z.string(), args: jsonValueSchema, reason: z.enum(["unseen", "refused"]) })
    .nullish(),
  /** Steps the agent took during replay (recorded in replay mode), for the report. */
  steps: z.array(jsonValueSchema).optional(),
  /** Side-effect tools the agent tried to call; refused, never executed. The trajectory ended there. */
  refusedSideEffects: z.array(z.object({ toolName: z.string(), args: jsonValueSchema })).optional(),
});
export type ReplayResultPost = z.infer<typeof replayResultPostSchema>;

export const replayResultsPostSchema = z.object({
  results: z.array(replayResultPostSchema).min(1).max(500),
  /** Mark the job finished after storing these results. */
  finish: z.boolean().default(false),
  error: z.string().nullish(),
});
export type ReplayResultsPost = z.infer<typeof replayResultsPostSchema>;

/** One row of the report: a case with its baseline, target and human correction side by side. */
export const reportRowSchema = z.object({
  caseId: uuidSchema,
  title: z.string(),
  kind: correctionKindSchema,
  agent: z.string(),
  runId: uuidSchema,
  scorer: scorerNameSchema,
  verdict: verdictSchema,
  passed: z.boolean().nullable(),
  score: z.number().nullable(),
  reason: z.string().nullable(),
  baselineOutput: jsonValueSchema.nullable(),
  targetOutput: jsonValueSchema.nullable(),
  expected: jsonValueSchema.nullable(),
  note: z.string().nullable(),
  actor: z.string().nullable(),
  error: z.string().nullable(),
  costUsd: z.number().nullable(),
  latencyMs: z.number().nullable(),
  /** Trajectory mode: side-effect tools the agent tried to call; refused, never executed. */
  refusedSideEffects: z.array(z.object({ toolName: z.string(), args: jsonValueSchema })).optional(),
  /** Trajectory mode: steps the agent took while replaying. */
  stepCount: z.number().int().optional(),
  /** Trajectory mode: tool calls answered from the recordings (simulated, not executed). */
  simulatedToolCalls: z.number().int().optional(),
  /** Verdict new_path: the call with no recording, and the recorded calls of the same tool it might be equivalent to. */
  newPath: z
    .object({
      toolName: z.string(),
      args: jsonValueSchema,
      fingerprint: z.string(),
      candidates: z.array(z.object({ fingerprint: z.string(), args: jsonValueSchema })),
    })
    .optional(),
  /** Contract rules this replay broke, in words. */
  contractViolations: z.array(z.string()).optional(),
});
export type ReportRow = z.infer<typeof reportRowSchema>;

export const replayReportSchema = z.object({
  job: replayJobSchema,
  summary: replaySummarySchema,
  regressions: z.array(reportRowSchema),
  /** Tool calls with no recording; block the gate until a human accepts or rejects the path. */
  newPaths: z.array(reportRowSchema),
  stillWrong: z.array(reportRowSchema),
  fixed: z.array(reportRowSchema),
  passed: z.array(reportRowSchema),
  unreplayable: z.array(reportRowSchema),
  errors: z.array(reportRowSchema),
  /** The CI verdict for this report: red on regressions, and on new paths unless the project allows them. */
  gate: z
    .object({
      pass: z.boolean(),
      reasons: z.array(z.string()),
      newPathsBlock: z.boolean(),
    })
    .optional(),
});
export type ReplayReport = z.infer<typeof replayReportSchema>;

export const replayListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: replayStatusSchema.optional(),
});

// ---------- prompt versions ----------

export const promptVersionCreateSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  template: z.string().min(1).max(200_000),
});
export type PromptVersionCreate = z.infer<typeof promptVersionCreateSchema>;

export const promptVersionSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  version: z.string(),
  template: z.string(),
  hash: z.string(),
  createdAt: isoDateSchema,
});
export type PromptVersion = z.infer<typeof promptVersionSchema>;

// ---------- trajectory model calls ----------

export const replayModelCallSchema = z.object({
  model: z.string().regex(/^[a-z0-9_-]+\/.+$/i, "model must be provider/model"),
  promptVersion: z.string().max(200).nullish(),
  input: z
    .object({
      provider: z.enum(["openai", "anthropic", "ai"]),
      messages: jsonValueSchema.optional(),
      system: jsonValueSchema.optional(),
      tools: jsonValueSchema.optional(),
      tool_choice: jsonValueSchema.optional(),
      response_format: jsonValueSchema.optional(),
      params: z.record(z.string(), jsonValueSchema).optional(),
    })
    .loose(),
});
export type ReplayModelCallRequest = z.infer<typeof replayModelCallSchema>;

export const replayModelCallResponseSchema = z.object({
  text: z.string(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), args: jsonValueSchema })),
  finishReason: z.string(),
  usage: usageSchema,
  modelId: z.string().nullable(),
  costUsd: z.number().nullable(),
});
export type ReplayModelCallResponse = z.infer<typeof replayModelCallResponseSchema>;

// ---------- owned models (train and gate) ----------

export const trainedModelStatusSchema = z.enum([
  "exporting",
  "uploading",
  "training",
  "trained",
  "gating",
  "passed",
  "failed",
  "promoted",
  "retired",
]);
export type TrainedModelStatus = z.infer<typeof trainedModelStatusSchema>;

export const trainCreateSchema = z.object({
  /** Together base model id, e.g. meta-llama/Meta-Llama-3.1-8B-Instruct-Reference */
  baseModel: z.string().min(1).max(200),
  method: z.enum(["sft", "dpo"]).default("sft"),
  epochs: z.number().int().min(1).max(10).default(3),
  /** Which cases to train on; the gate replays the same filter. */
  filter: caseFilterSchema.partial().default({}),
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
  /** Fewer rows than this refuses to train and points at corrections-in-the-prompt instead. */
  minRows: z.number().int().min(1).default(50),
});
export type TrainCreate = z.infer<typeof trainCreateSchema>;

export const modelGateSchema = z.object({
  pass: z.boolean(),
  replayJobId: uuidSchema.nullable(),
  passRate: z.number().nullable(),
  regressions: z.number().int(),
  newPaths: z.number().int(),
  /** The pass rate of the model the cases were recorded with, on the same cases, when a replay of it exists. */
  incumbentModel: z.string().nullable(),
  incumbentPassRate: z.number().nullable(),
  reasons: z.array(z.string()),
});
export type ModelGate = z.infer<typeof modelGateSchema>;

export const shadowStatsSchema = z.object({
  runs: z.number().int(),
  agreesWithProduction: z.number().int(),
  scored: z.number().int(),
  passed: z.number().int(),
  /** Of the runs a human corrected, how often the shadow model's answer was the corrected one. */
  passRate: z.number().nullable(),
  errors: z.number().int(),
  costUsd: z.number(),
});
export type ShadowStats = z.infer<typeof shadowStatsSchema>;

export const trainedModelSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  name: z.string(),
  provider: z.string(),
  baseModel: z.string(),
  method: z.enum(["sft", "dpo"]),
  epochs: z.number().int(),
  caseFilter: jsonValueSchema,
  datasetStats: exportStatsSchema.nullable(),
  status: trainedModelStatusSchema,
  error: z.string().nullable(),
  providerJobId: z.string().nullable(),
  outputName: z.string().nullable(),
  servedAs: z.string().nullable(),
  trainingCostUsd: z.number().nullable(),
  gateJobId: uuidSchema.nullable(),
  gate: modelGateSchema.nullable(),
  shadow: z.boolean(),
  shadowSince: isoDateSchema.nullable(),
  shadowStats: shadowStatsSchema.nullable(),
  promotedAt: isoDateSchema.nullable(),
  finishedAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
});
export type TrainedModel = z.infer<typeof trainedModelSchema>;

export const trainedModelPatchSchema = z.object({
  /** Where the trained weights answer from (provider/model). Set this when the provider needs a dedicated endpoint. */
  servedAs: z.string().min(3).max(300).optional(),
  shadow: z.boolean().optional(),
});
export type TrainedModelPatch = z.infer<typeof trainedModelPatchSchema>;
