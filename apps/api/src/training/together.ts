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
