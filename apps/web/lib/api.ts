"use client";

import type {
  Case,
  CaseCounts,
  CaseDedupeResult,
  CaseEquivalent,
  CaseSummary,
  Correction,
  CorrectionCreate,
  CorrectionResult,
  ExportStats,
  Page,
  Project,
  ProjectPatch,
  PromptVersion,
  ReplayCreate,
  ReplayEstimate,
  ReplayJob,
  ReplayMatrix,
  ReplayReport,
  ReplayResult,
  Run,
  RunWithSteps,
  TrainedModel,
} from "@overturn-ai/shared";

const PROJECT_KEY = "overturn.project";

let apiUrlPromise: Promise<string> | null = null;
/** Resolved once per page load from /config (runtime env), falling back to the build-time value. */
export function getApiUrl(): Promise<string> {
  if (!apiUrlPromise) {
    apiUrlPromise = fetch("/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("config"))))
      .then((c: { apiUrl: string }) => c.apiUrl)
      .catch(() => (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, ""));
  }
  return apiUrlPromise;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function currentProjectId(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}
export function setCurrentProjectId(id: string | null): void {
  try {
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {}
}

type Query = Record<string, string | number | boolean | undefined>;

export async function api<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const qs = query
    ? `?${Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")}`
    : "";
  const project = currentProjectId();
  const base = await getApiUrl();
  const res = await fetch(`${base}${path}${qs === "?" ? "" : qs}`, {
    method,
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(project ? { "x-overturn-project": project } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = parsed as { message?: string; details?: unknown } | null;
    throw new ApiError(res.status, err?.message ?? `${method} ${path} failed (${res.status})`, err?.details);
  }
  return parsed as T;
}

export interface SessionInfo {
  user: { id: string; email: string; name: string | null } | null;
  project: { id: string; name: string; slug: string; organizationId: string };
  projects: Array<{
    id: string;
    name: string;
    slug: string;
    organizationId: string;
    organizationName: string;
    role: string;
  }>;
  via: "session" | "api-key";
}

export const client = {
  session: () => api<SessionInfo>("GET", "/v1/auth/session"),
  magicLink: (email: string) =>
    api<{ sent: boolean; devUrl: string | null }>("POST", "/v1/auth/magic-link", { email }),
  verify: (token: string) =>
    api<{ user: { email: string }; isNew: boolean }>("POST", "/v1/auth/verify", { token }),
  logout: () => api<void>("POST", "/v1/auth/logout"),
  runs: {
    list: (q: Query) => api<Page<Run>>("GET", "/v1/runs", undefined, q),
    get: (id: string) => api<RunWithSteps>("GET", `/v1/runs/${id}`),
    stats: () =>
      api<{ runs7d: number; corrected7d: number; correctedRate7d: number }>("GET", "/v1/runs/stats"),
  },
  corrections: {
    create: (body: Omit<CorrectionCreate, "source">) =>
      api<CorrectionResult>("POST", "/v1/corrections", { ...body, source: "ui" }),
    list: (runId: string) => api<Correction[]>("GET", "/v1/corrections", undefined, { runId }),
  },
  cases: {
    list: (q: Query) => api<Page<CaseSummary>>("GET", "/v1/cases", undefined, q),
    get: (id: string) => api<Case>("GET", `/v1/cases/${id}`),
    patch: (id: string, body: Record<string, unknown>) => api<Case>("PATCH", `/v1/cases/${id}`, body),
    counts: () => api<CaseCounts>("GET", "/v1/cases/counts"),
    dedupe: () => api<CaseDedupeResult>("POST", "/v1/cases/dedupe"),
    acceptEquivalent: (id: string, body: CaseEquivalent) =>
      api<Case>("POST", `/v1/cases/${id}/equivalents`, body),
    sets: () => api<Array<{ id: string; name: string; filter: unknown }>>("GET", "/v1/case-sets"),
  },
  models: {
    list: () => api<TrainedModel[]>("GET", "/v1/models"),
    get: (id: string) => api<TrainedModel>("GET", `/v1/models/${id}`),
    create: (body: Record<string, unknown>) => api<TrainedModel>("POST", "/v1/models", body),
    patch: (id: string, body: Record<string, unknown>) =>
      api<TrainedModel>("PATCH", `/v1/models/${id}`, body),
    promote: (id: string) => api<TrainedModel>("POST", `/v1/models/${id}/promote`),
    retire: (id: string) => api<TrainedModel>("POST", `/v1/models/${id}/retire`),
  },
  exportStats: (q: Query) => api<ExportStats>("GET", "/v1/export/stats", undefined, q),
  replays: {
    list: (q: Query = {}) => api<ReplayJob[]>("GET", "/v1/replays", undefined, q),
    get: (id: string) => api<ReplayJob>("GET", `/v1/replays/${id}`),
    estimate: (body: { model: string; filter: Record<string, unknown> }) =>
      api<ReplayEstimate>("POST", "/v1/replays/estimate", body),
    create: (body: Partial<ReplayCreate> & { model: string }) =>
      api<{ job: ReplayJob; jobs: ReplayJob[]; estimate: ReplayEstimate }>("POST", "/v1/replays", body),
    matrix: (groupId: string) => api<ReplayMatrix>("GET", `/v1/replays/groups/${groupId}`),
    cancel: (id: string) => api<ReplayJob>("POST", `/v1/replays/${id}/cancel`),
    results: (id: string) => api<ReplayResult[]>("GET", `/v1/replays/${id}/results`),
    report: (id: string) => api<ReplayReport>("GET", `/v1/replays/${id}/report`),
    caseResults: (caseId: string) =>
      api<Array<ReplayResult & { targetModel: string; targetPromptVersion: string | null; mode: string }>>(
        "GET",
        `/v1/cases/${caseId}/results`,
      ),
  },
  prompts: { list: () => api<PromptVersion[]>("GET", "/v1/prompts") },
  project: {
    get: () => api<Project>("GET", "/v1/project"),
    patch: (body: ProjectPatch) => api<Project>("PATCH", "/v1/project", body),
    webhookTest: () =>
      api<{ ok: boolean; status?: number; error?: string }>("POST", "/v1/project/webhook-test"),
  },
  keys: {
    list: () =>
      api<
        Array<{
          id: string;
          name: string;
          prefix: string;
          lastUsedAt: string | null;
          revokedAt: string | null;
          createdAt: string;
        }>
      >("GET", "/v1/api-keys"),
    create: (name: string) =>
      api<{ id: string; key: string; prefix: string }>("POST", "/v1/api-keys", { name }),
    revoke: (id: string) => api<void>("DELETE", `/v1/api-keys/${id}`),
  },
  members: {
    list: () =>
      api<Array<{ id: string; email: string; name: string | null; role: string; createdAt: string }>>(
        "GET",
        "/v1/members",
      ),
    add: (email: string) => api<unknown>("POST", "/v1/members", { email }),
    remove: (id: string) => api<void>("DELETE", `/v1/members/${id}`),
  },
};
