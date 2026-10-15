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
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

// ---------- corrections ----------

export const correctionCreateSchema = z.object({
  runId: uuidSchema,
  stepId: uuidSchema.nullish(),
  kind: correctionKindSchema,
  correctedOutput: jsonValueSchema.optional(),
  note: z.string().max(10_000).nullish(),
  actor: z.string().max(200).nullish(),
  source: correctionSourceSchema.default("api"),
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

export const caseStatusSchema = z.enum(["active", "archived"]);
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
});
export type CasePatch = z.infer<typeof casePatchSchema>;

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
