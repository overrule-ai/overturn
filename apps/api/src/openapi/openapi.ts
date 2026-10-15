/**
 * OpenAPI 3.1 document assembled from the zod schemas in @overturn/shared, the single
 * source of truth for payload shapes. Served at GET /openapi.json.
 */
import {
  caseListQuerySchema,
  casePatchSchema,
  caseSchema,
  caseSetCreateSchema,
  caseSetSchema,
  caseSummarySchema,
  correctionCreateSchema,
  correctionListQuerySchema,
  correctionResultSchema,
  correctionSchema,
  ingestPayloadSchema,
  ingestResponseSchema,
  meResponseSchema,
  pageSchema,
  projectPatchSchema,
  projectSchema,
  promptVersionCreateSchema,
  promptVersionSchema,
  replayCreateSchema,
  replayEstimateSchema,
  replayJobSchema,
  replayListQuerySchema,
  replayModelCallResponseSchema,
  replayModelCallSchema,
  replayReportSchema,
  replayResultSchema,
  replayResultsPostSchema,
  runListQuerySchema,
  runSchema,
  runWithStepsSchema,
} from "@overturn/shared";
import { z } from "zod";

interface Route {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  tag: string;
  body?: z.ZodType;
  query?: z.ZodType;
  response?: z.ZodType;
  status?: number;
  auth?: boolean;
}

const uuidParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const ROUTES: Route[] = [
  { method: "get", path: "/health", summary: "Liveness and database check", tag: "meta", auth: false },
  {
    method: "get",
    path: "/v1/me",
    summary: "The project behind this API key",
    tag: "meta",
    response: meResponseSchema,
  },
  {
    method: "get",
    path: "/v1/project",
    summary: "Project settings",
    tag: "project",
    response: projectSchema,
  },
  {
    method: "patch",
    path: "/v1/project",
    summary: "Update project settings",
    tag: "project",
    body: projectPatchSchema,
    response: projectSchema,
  },
  {
    method: "post",
    path: "/v1/ingest",
    summary: "Record runs and steps (idempotent upsert, batched by the SDKs)",
    tag: "record",
    body: ingestPayloadSchema,
    response: ingestResponseSchema,
    status: 202,
  },
  {
    method: "post",
    path: "/v1/traces",
    summary: "OTLP/HTTP traces (JSON or protobuf) with GenAI semantic conventions",
    tag: "record",
  },
  {
    method: "get",
    path: "/v1/runs",
    summary: "List runs",
    tag: "runs",
    query: runListQuerySchema,
    response: pageSchema(runSchema),
  },
  { method: "get", path: "/v1/runs/stats", summary: "Corrected rate over the last 7 days", tag: "runs" },
  {
    method: "get",
    path: "/v1/runs/{id}",
    summary: "A run with its steps",
    tag: "runs",
    response: runWithStepsSchema,
  },
  {
    method: "post",
    path: "/v1/corrections",
    summary: "Record a human correction; freezes a regression case",
    tag: "correct",
    body: correctionCreateSchema,
    response: correctionResultSchema,
    status: 201,
  },
  {
    method: "get",
    path: "/v1/corrections",
    summary: "List corrections",
    tag: "correct",
    query: correctionListQuerySchema,
    response: z.array(correctionSchema),
  },
  {
    method: "get",
    path: "/v1/cases",
    summary: "List cases",
    tag: "cases",
    query: caseListQuerySchema,
    response: pageSchema(caseSummarySchema),
  },
  {
    method: "get",
    path: "/v1/cases/{id}",
    summary: "A case with frozen input and tool recordings",
    tag: "cases",
    response: caseSchema,
  },
  {
    method: "get",
    path: "/v1/cases/{id}/results",
    summary: "Replay results for a case, newest first",
    tag: "cases",
    response: z.array(replayResultSchema),
  },
  {
    method: "patch",
    path: "/v1/cases/{id}",
    summary: "Archive, retag or change the scorer of a case",
    tag: "cases",
    body: casePatchSchema,
    response: caseSchema,
  },
  {
    method: "get",
    path: "/v1/case-sets",
    summary: "Saved case sets",
    tag: "cases",
    response: z.array(caseSetSchema),
  },
  {
    method: "post",
    path: "/v1/case-sets",
    summary: "Save a case filter as a set",
    tag: "cases",
    body: caseSetCreateSchema,
    response: caseSetSchema,
    status: 201,
  },
  { method: "delete", path: "/v1/case-sets/{id}", summary: "Delete a case set", tag: "cases", status: 204 },
  {
    method: "post",
    path: "/v1/replays/estimate",
    summary: "Cost estimate for a replay",
    tag: "replay",
    body: replayCreateSchema.pick({ model: true, filter: true }),
    response: replayEstimateSchema,
  },
  {
    method: "post",
    path: "/v1/replays",
    summary: "Create (and start) a replay job",
    tag: "replay",
    body: replayCreateSchema,
    response: z.object({
      job: replayJobSchema,
      estimate: replayEstimateSchema,
      caseIds: z.array(z.string()),
    }),
    status: 201,
  },
  {
    method: "get",
    path: "/v1/replays",
    summary: "List replay jobs",
    tag: "replay",
    query: replayListQuerySchema,
    response: z.array(replayJobSchema),
  },
  {
    method: "get",
    path: "/v1/replays/{id}",
    summary: "A replay job",
    tag: "replay",
    response: replayJobSchema,
  },
  {
    method: "post",
    path: "/v1/replays/{id}/cancel",
    summary: "Cancel a running replay",
    tag: "replay",
    response: replayJobSchema,
  },
  {
    method: "get",
    path: "/v1/replays/{id}/results",
    summary: "Per-case results",
    tag: "replay",
    response: z.array(replayResultSchema),
  },
  {
    method: "post",
    path: "/v1/replays/{id}/results",
    summary: "Post trajectory results (CLI)",
    tag: "replay",
    body: replayResultsPostSchema,
    response: replayJobSchema,
  },
  {
    method: "get",
    path: "/v1/replays/{id}/report",
    summary: "Report: regressions, still wrong, fixed",
    tag: "replay",
    response: replayReportSchema,
  },
  {
    method: "get",
    path: "/v1/replays/{id}/report.md",
    summary: "The same report as markdown",
    tag: "replay",
  },
  {
    method: "post",
    path: "/v1/replays/model",
    summary: "Call the target model for a trajectory replay (cached)",
    tag: "replay",
    body: replayModelCallSchema,
    response: replayModelCallResponseSchema,
  },
  {
    method: "post",
    path: "/v1/prompts",
    summary: "Register a prompt version",
    tag: "replay",
    body: promptVersionCreateSchema,
    response: promptVersionSchema,
    status: 201,
  },
  {
    method: "get",
    path: "/v1/prompts",
    summary: "List prompt versions",
    tag: "replay",
    response: z.array(promptVersionSchema),
  },
  {
    method: "post",
    path: "/v1/auth/magic-link",
    summary: "Request a sign-in link",
    tag: "auth",
    auth: false,
  },
  {
    method: "post",
    path: "/v1/auth/verify",
    summary: "Exchange a magic-link token for a session cookie",
    tag: "auth",
    auth: false,
  },
  { method: "post", path: "/v1/auth/logout", summary: "Revoke the session", tag: "auth", status: 204 },
  { method: "get", path: "/v1/auth/session", summary: "Current user and projects", tag: "auth" },
  { method: "get", path: "/v1/api-keys", summary: "List API keys", tag: "auth" },
  {
    method: "post",
    path: "/v1/api-keys",
    summary: "Create an API key (shown once)",
    tag: "auth",
    status: 201,
  },
  { method: "delete", path: "/v1/api-keys/{id}", summary: "Revoke an API key", tag: "auth", status: 204 },
  { method: "get", path: "/v1/members", summary: "Workspace members", tag: "auth" },
  { method: "post", path: "/v1/members", summary: "Add a member by email", tag: "auth", status: 201 },
  { method: "delete", path: "/v1/members/{id}", summary: "Remove a member", tag: "auth", status: 204 },
];

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { target: "openapi-3.0", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
  } catch {
    return { type: "object" };
  }
}

function queryParams(schema: z.ZodType): unknown[] {
  const js = jsonSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, s]) => ({
    name,
    in: "query",
    required: js.required?.includes(name) ?? false,
    schema: s,
  }));
}

let cached: Record<string, unknown> | null = null;

export function buildOpenApi(serverUrl?: string): Record<string, unknown> {
  if (cached) return cached;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const op: Record<string, unknown> = {
      summary: r.summary,
      tags: [r.tag],
      operationId: `${r.method}_${r.path.replace(/[{}/.]+/g, "_").replace(/^_|_$/g, "")}`,
    };
    const params: unknown[] = [];
    if (r.path.includes("{id}")) params.push(uuidParam);
    if (r.query) params.push(...queryParams(r.query));
    if (params.length) op.parameters = params;
    if (r.body)
      op.requestBody = { required: true, content: { "application/json": { schema: jsonSchema(r.body) } } };
    const status = String(r.status ?? 200);
    op.responses = {
      [status]: r.response
        ? { description: "OK", content: { "application/json": { schema: jsonSchema(r.response) } } }
        : { description: "OK" },
      "400": {
        description: "Validation failed",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
      "401": { description: "Missing or invalid API key / session" },
    };
    if (r.auth !== false) op.security = [{ apiKey: [] }, { session: [] }];
    paths[r.path] = { ...(paths[r.path] ?? {}), [r.method]: op };
  }
  cached = {
    openapi: "3.1.0",
    info: {
      title: "Overturn API",
      version: "0.1.0",
      description:
        "Every time a human corrects your agent, it becomes a test. Record runs, turn corrections into cases, replay against any model.",
      license: { name: "Apache-2.0" },
    },
    servers: serverUrl ? [{ url: serverUrl }] : [],
    tags: ["meta", "project", "record", "runs", "correct", "cases", "replay", "auth"].map((name) => ({
      name,
    })),
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "Project API key: ov_live_…" },
        session: {
          type: "apiKey",
          in: "cookie",
          name: "ov_session",
          description: "Web session; add x-overturn-project to pick a project",
        },
      },
      schemas: {
        ApiError: {
          type: "object",
          properties: {
            statusCode: { type: "integer" },
            error: { type: "string" },
            message: { type: "string" },
            details: {},
          },
          required: ["statusCode", "error", "message"],
        },
      },
    },
    paths,
  };
  return cached;
}
