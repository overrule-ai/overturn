import type {
  ApiError,
  Case,
  CaseListQuery,
  CasePatch,
  CaseSet,
  CaseSetCreate,
  CaseSummary,
  Correction,
  CorrectionCreate,
  CorrectionResult,
  MeResponse,
  Page,
  Project,
  ProjectPatch,
  PromptVersion,
  PromptVersionCreate,
  ReplayCreate,
  ReplayEstimate,
  ReplayJob,
  ReplayReport,
  ReplayResult,
  ReplayResultsPost,
  Run,
  RunListQuery,
  RunWithSteps,
} from "@overturn-ai/shared";
import { VERSION } from "./version.js";

export class OverturnApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError | null,
    message: string,
  ) {
    super(message);
    this.name = "OverturnApiError";
  }
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

function qs(q: Query | undefined): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) p.append(k, item);
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Thin typed client for the Overturn REST API, used by the SDK's correct() and by the CLI. */
export class OverturnApi {
  constructor(
    private readonly options: { apiKey: string; baseUrl: string; fetch?: typeof fetch; userAgent?: string },
  ) {}

  async request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const f = this.options.fetch ?? globalThis.fetch;
    const res = await f(`${this.options.baseUrl.replace(/\/+$/, "")}${path}${qs(query)}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        authorization: `Bearer ${this.options.apiKey}`,
        "user-agent": this.options.userAgent ?? `overturn-sdk-js/${VERSION}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const err = parsed as ApiError | null;
      throw new OverturnApiError(
        res.status,
        err,
        `${method} ${path} failed: ${res.status} ${err?.message ?? text.slice(0, 200)}`,
      );
    }
    return parsed as T;
  }

  me(): Promise<MeResponse> {
    return this.request("GET", "/v1/me");
  }

  readonly project = {
    get: (): Promise<Project> => this.request("GET", "/v1/project"),
    patch: (body: ProjectPatch): Promise<Project> => this.request("PATCH", "/v1/project", body),
  };

  readonly runs = {
    list: (q: Partial<RunListQuery> = {}): Promise<Page<Run>> =>
      this.request("GET", "/v1/runs", undefined, q),
    get: (id: string): Promise<RunWithSteps> => this.request("GET", `/v1/runs/${id}`),
    stats: (): Promise<{ runs7d: number; corrected7d: number; correctedRate7d: number }> =>
      this.request("GET", "/v1/runs/stats"),
  };

  readonly corrections = {
    create: (body: CorrectionCreate): Promise<CorrectionResult> =>
      this.request("POST", "/v1/corrections", body),
    list: (q: { runId?: string; limit?: number } = {}): Promise<Correction[]> =>
      this.request("GET", "/v1/corrections", undefined, q),
  };

  readonly cases = {
    list: (q: Partial<CaseListQuery> = {}): Promise<Page<CaseSummary>> =>
      this.request("GET", "/v1/cases", undefined, q),
    get: (id: string): Promise<Case> => this.request("GET", `/v1/cases/${id}`),
    patch: (id: string, body: CasePatch): Promise<Case> => this.request("PATCH", `/v1/cases/${id}`, body),
  };

  readonly replays = {
    estimate: (body: { model: string; filter?: Partial<CaseListQuery> }): Promise<ReplayEstimate> =>
      this.request("POST", "/v1/replays/estimate", body),
    create: (
      body: Partial<ReplayCreate> & { model: string },
    ): Promise<{ job: ReplayJob; estimate: ReplayEstimate; caseIds: string[] }> =>
      this.request("POST", "/v1/replays", body),
    list: (q: { limit?: number; status?: ReplayJob["status"] } = {}): Promise<ReplayJob[]> =>
      this.request("GET", "/v1/replays", undefined, q),
    get: (id: string): Promise<ReplayJob> => this.request("GET", `/v1/replays/${id}`),
    cancel: (id: string): Promise<ReplayJob> => this.request("POST", `/v1/replays/${id}/cancel`),
    results: (id: string): Promise<ReplayResult[]> => this.request("GET", `/v1/replays/${id}/results`),
    postResults: (id: string, body: ReplayResultsPost): Promise<ReplayJob> =>
      this.request("POST", `/v1/replays/${id}/results`, body),
    report: (id: string): Promise<ReplayReport> => this.request("GET", `/v1/replays/${id}/report`),
  };

  readonly prompts = {
    register: (body: PromptVersionCreate): Promise<PromptVersion> =>
      this.request("POST", "/v1/prompts", body),
    list: (name?: string): Promise<PromptVersion[]> =>
      this.request("GET", "/v1/prompts", undefined, { name }),
  };

  readonly caseSets = {
    list: (): Promise<CaseSet[]> => this.request("GET", "/v1/case-sets"),
    create: (body: CaseSetCreate): Promise<CaseSet> => this.request("POST", "/v1/case-sets", body),
    delete: (id: string): Promise<void> => this.request("DELETE", `/v1/case-sets/${id}`),
  };
}
