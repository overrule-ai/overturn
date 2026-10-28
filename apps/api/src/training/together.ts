/**
 * Paths are relative to TOGETHER_BASE_URL (…/v1). The slice of Together AI's API that training uses: upload a JSONL file, create a LoRA
 * fine-tune, poll it. Plain fetch; the shapes come from Together's own SDK types.
 */
export interface TogetherFineTune {
  id: string;
  status:
    | "pending"
    | "queued"
    | "running"
    | "compressing"
    | "uploading"
    | "cancel_requested"
    | "cancelled"
    | "error"
    | "completed";
  model: string;
  model_output_name?: string;
  token_count?: number;
  total_price?: number;
  error?: string | null;
}

export class TogetherClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  private async call<T>(method: string, path: string, body?: BodyInit, contentType?: string): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(contentType ? { "content-type": contentType } : {}),
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Together ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  /** Uploads a JSONL training file; returns the file id. */
  async uploadFile(name: string, jsonl: string): Promise<string> {
    const form = new FormData();
    form.set("purpose", "fine-tune");
    form.set("file_name", name);
    form.set("file", new Blob([jsonl], { type: "application/jsonl" }), name);
    const r = await this.call<{ id: string }>("POST", "/files/upload", form);
    return r.id;
  }

  async createFineTune(input: {
    model: string;
    trainingFile: string;
    suffix: string;
    nEpochs: number;
    method: "sft" | "dpo";
    loraR?: number;
  }): Promise<TogetherFineTune> {
    const body = {
      model: input.model,
      training_file: input.trainingFile,
      suffix: input.suffix,
      n_epochs: input.nEpochs,
      training_type: { type: "Lora", lora_r: input.loraR ?? 16, lora_alpha: (input.loraR ?? 16) * 2 },
      training_method:
        input.method === "dpo"
          ? { method: "dpo", dpo_beta: 0.1 }
          : { method: "sft", train_on_inputs: "auto" },
    };
    return this.call<TogetherFineTune>("POST", "/fine-tunes", JSON.stringify(body), "application/json");
  }

  getFineTune(id: string): Promise<TogetherFineTune> {
    return this.call<TogetherFineTune>("GET", `/fine-tunes/${encodeURIComponent(id)}`);
  }

  cancelFineTune(id: string): Promise<unknown> {
    return this.call("POST", `/fine-tunes/${encodeURIComponent(id)}/cancel`);
  }
}

// ---------- dedicated endpoints (Together v2: project → endpoint → deployment [+ LoRA adapter]) ----------

export interface TogetherModel {
  id: string;
  name: string;
  projectId: string;
  baseModel?: string;
  baseModelId?: string;
  weights?: { type?: "WEIGHTS_TYPE_DEFAULT" | "WEIGHTS_TYPE_SPECULATOR" | "WEIGHTS_TYPE_ADAPTER" };
}

export interface TogetherConfig {
  id: string;
  projectId: string;
  referenceModel: string;
  selectors: Array<{ key: string; value: string }>;
  certifications: Array<{
    certificationType: "CERTIFICATION_TYPE_CERTIFIED" | "CERTIFICATION_TYPE_UNCERTIFIED";
  }>;
}

export type TogetherDeploymentState =
  | "DEPLOYMENT_STATE_PROVISIONING"
  | "DEPLOYMENT_STATE_READY"
  | "DEPLOYMENT_STATE_SCALING"
  | "DEPLOYMENT_STATE_DEGRADED"
  | "DEPLOYMENT_STATE_FAILED"
  | "DEPLOYMENT_STATE_STOPPED"
  | "DEPLOYMENT_STATE_STOPPING";

export interface TogetherDeployment {
  id: string;
  name: string;
  endpointId: string;
  model: string;
  hardware?: string;
  status: { state: TogetherDeploymentState; message?: string };
}

export interface TogetherAdapter {
  id: string;
  adapterModelId: string;
  perCluster: Array<{ state: string; readyPodCount: number; totalPodCount: number; message?: string }>;
}

/** The serving slice of Together's v2 API; project-scoped. Plain fetch, shapes from the SDK types. */
export class TogetherServing {
  constructor(
    private readonly apiKey: string,
    baseUrl: string,
    readonly projectId: string,
  ) {
    this.v2 = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v2/projects/${encodeURIComponent(projectId)}`;
  }
  private readonly v2: string;

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.v2}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Together ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** The project's models; a fine-tune's output appears here under its model_output_name. */
  async models(): Promise<TogetherModel[]> {
    const out: TogetherModel[] = [];
    let token: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await this.call<{
        models?: TogetherModel[];
        data?: TogetherModel[];
        nextPageToken?: string;
      }>("GET", `/models?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
      out.push(...(page.models ?? page.data ?? []));
      token = page.nextPageToken;
      if (!token) break;
    }
    return out;
  }

  async findModel(name: string): Promise<TogetherModel | null> {
    const all = await this.models();
    return (
      all.find((m) => m.name === name) ??
      all.find((m) => m.name.endsWith(`/${name}`) || name.endsWith(`/${m.name}`)) ??
      null
    );
  }

  /** Configs (hardware + runtime) certified for a model resource, fewest GPUs first. */
  async configsFor(modelResource: string): Promise<TogetherConfig[]> {
    const page = await this.call<{ configs?: TogetherConfig[]; data?: TogetherConfig[] }>(
      "GET",
      `/configs?referenceModel=${encodeURIComponent(modelResource)}&pageSize=100`,
    );
    const gpus = (c: TogetherConfig) =>
      Number(c.selectors.find((s) => /gpu.?count|num.?gpus|replica.?gpus/i.test(s.key))?.value ?? 1);
    return (page.configs ?? page.data ?? [])
      .filter(
        (c) => c.certifications?.some((x) => x.certificationType === "CERTIFICATION_TYPE_CERTIFIED") ?? true,
      )
      .sort((a, b) => gpus(a) - gpus(b));
  }

  createEndpoint(name: string): Promise<{ id: string; name: string }> {
    return this.call("POST", "/endpoints", { name, visibility: "VISIBILITY_PRIVATE" });
  }

  deleteEndpoint(id: string): Promise<unknown> {
    return this.call("DELETE", `/endpoints/${encodeURIComponent(id)}`);
  }

  createDeployment(
    endpointId: string,
    input: {
      name: string;
      model: string;
      config: string;
      minReplicas: number;
      maxReplicas: number;
      inactiveTimeout?: number;
    },
    validateOnly = false,
  ): Promise<TogetherDeployment> {
    const { minReplicas, maxReplicas, ...rest } = input;
    return this.call(
      "POST",
      `/endpoints/${encodeURIComponent(endpointId)}/deployments${validateOnly ? "?validateOnly=true" : ""}`,
      { ...rest, autoscaling: { minReplicas, maxReplicas } },
    );
  }

  getDeployment(endpointId: string, id: string): Promise<TogetherDeployment> {
    return this.call(
      "GET",
      `/endpoints/${encodeURIComponent(endpointId)}/deployments/${encodeURIComponent(id)}`,
    );
  }

  attachAdapter(endpointId: string, deploymentId: string, adapterModelId: string): Promise<TogetherAdapter> {
    return this.call(
      "POST",
      `/endpoints/${encodeURIComponent(endpointId)}/deployments/${encodeURIComponent(deploymentId)}/adapters`,
      { adapterModelId },
    );
  }

  getAdapter(endpointId: string, deploymentId: string, id: string): Promise<TogetherAdapter> {
    return this.call(
      "GET",
      `/endpoints/${encodeURIComponent(endpointId)}/deployments/${encodeURIComponent(deploymentId)}/adapters/${encodeURIComponent(id)}`,
    );
  }
}
