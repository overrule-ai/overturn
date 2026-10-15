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
