import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type {
  CaseFilter,
  ExportStats,
  ModelDeployPlan,
  ModelDeployRequest,
  ModelGate,
  ModelRegister,
  ModelServing,
  ShadowStats,
  TrainCreate,
  TrainedModel,
  TrainedModelPatch,
} from "@overturn-ai/shared";
import { decisionFields, extractAnswer, score } from "@overturn-ai/shared";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { APP_CONFIG, type AppConfig } from "../config";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import {
  cases,
  corrections,
  projects,
  replayJobs,
  runs,
  shadowResults,
  steps,
  type TrainedModelRow,
  trainedModels,
} from "../db/schema";
import { ExportService } from "../export/export.service";
import { ModelRegistry, parseModel } from "../models/registry";
import { NotifyService } from "../notify/notify.service";
import { parseSettings } from "../projects/settings";
import { callModel } from "../replay/model-call";
import { ReplayService } from "../replay/replay.service";
import { TogetherClient, TogetherServing } from "./together";

const TERMINAL = new Set(["cancelled", "error", "completed"]);

function serialize(r: TrainedModelRow, shadowStats: ShadowStats | null): TrainedModel {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    provider: r.provider,
    baseModel: r.baseModel,
    method: r.method as TrainedModel["method"],
    epochs: r.epochs,
    caseFilter: r.caseFilter,
    datasetStats: (r.datasetStats ?? null) as ExportStats | null,
    status: r.status as TrainedModel["status"],
    error: r.error,
    providerJobId: r.providerJobId,
    outputName: r.outputName,
    servedAs: r.servedAs,
    trigger: r.trigger as TrainedModel["trigger"],
    serving: (r.serving ?? null) as ModelServing | null,
    trainingCostUsd: r.trainingCostUsd,
    gateJobId: r.gateJobId,
    gate: (r.gate ?? null) as ModelGate | null,
    shadow: r.shadow,
    shadowSince: r.shadowSince?.toISOString() ?? null,
    shadowStats,
    promotedAt: r.promotedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Train and gate. A model is trained on the project's corrections (the same export a user can
 * download), replayed against the suite like any other candidate, and only a human promotes
 * it — after shadow mode if they want live evidence first. Nothing is ever promoted by itself.
 */
@Injectable()
export class TrainingService {
  private readonly logger = new Logger(TrainingService.name);
  private readonly registry: ModelRegistry;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly exporter: ExportService,
    private readonly replay: ReplayService,
    private readonly notify: NotifyService,
  ) {
    this.registry = new ModelRegistry(config);
  }

  private together(): TogetherClient {
    if (!this.config.TOGETHER_API_KEY)
      throw new BadRequestException("Training needs TOGETHER_API_KEY on the server");
    return new TogetherClient(this.config.TOGETHER_API_KEY, this.config.TOGETHER_BASE_URL);
  }

  /** Serving is on when TOGETHER_PROJECT_ID is set: trained weights get a dedicated endpoint before the gate. */
  private serving(): TogetherServing | null {
    if (!this.config.TOGETHER_API_KEY || !this.config.TOGETHER_PROJECT_ID) return null;
    return new TogetherServing(
      this.config.TOGETHER_API_KEY,
      this.config.TOGETHER_BASE_URL,
      this.config.TOGETHER_PROJECT_ID,
    );
  }

  // ---------- create ----------

  async create(
    projectId: string,
    input: TrainCreate,
    trigger: "manual" | "auto" = "manual",
  ): Promise<TrainedModel> {
    this.together();
    const filter: CaseFilter = { status: "active", ...input.filter };
    const stats = await this.exporter.stats(projectId, {
      format: input.method,
      agent: filter.agent,
      tag: filter.tag,
      set: filter.set,
      since: filter.since,
      includeApproved: true,
      limit: 50_000,
    });
    if (stats.rows < input.minRows)
      throw new BadRequestException(
        `${stats.rows} ${input.method} rows is under the ${input.minRows} needed for a fine-tune to beat the model you have. ` +
          "Until then, put corrections in the prompt: replay with --examples 5 and measure the lift.",
      );
    const name = input.name ?? `ov-${new Date().toISOString().slice(0, 10)}-${uuidv7().slice(-6)}`;
    const [row] = await this.db
      .insert(trainedModels)
      .values({
        id: uuidv7(),
        projectId,
        name,
        provider: "together",
        baseModel: input.baseModel,
        method: input.method,
        epochs: input.epochs,
        caseFilter: filter,
        datasetStats: stats,
        status: "exporting",
        trigger,
      })
      .returning();
    return serialize(row!, null);
  }

  /**
   * Weights trained anywhere else — your own cloud with `overturn-trainer`, a notebook, another
   * provider — enter the same lifecycle here: the row is "trained", the gate replays the suite
   * against `servedAs`, then shadow and promotion work as for a Together fine-tune.
   */
  async register(projectId: string, input: ModelRegister): Promise<TrainedModel> {
    const { provider } = parseModel(input.servedAs);
    if (!this.registry.isConfigured(provider))
      throw new BadRequestException(
        `Provider ${provider} is not configured on the server (for local/ set LOCAL_MODEL_BASE_URL)`,
      );
    const filter: CaseFilter = { status: "active", ...input.filter };
    const stats =
      input.datasetStats ??
      (await this.exporter.stats(projectId, {
        format: input.method,
        agent: filter.agent,
        tag: filter.tag,
        set: filter.set,
        since: filter.since,
        includeApproved: true,
        limit: 50_000,
      }));
    const name = input.name ?? `ext-${new Date().toISOString().slice(0, 10)}-${uuidv7().slice(-6)}`;
    const [row] = await this.db
      .insert(trainedModels)
      .values({
        id: uuidv7(),
        projectId,
        name,
        provider,
        baseModel: input.baseModel,
        method: input.method,
        epochs: input.epochs,
        caseFilter: filter,
        datasetStats: stats,
        status: "trained",
        outputName: input.servedAs.slice(input.servedAs.indexOf("/") + 1),
        servedAs: input.servedAs,
        trainingCostUsd: input.trainingCostUsd ?? null,
      })
      .returning();
    return this.gate(row!.id);
  }

  // ---------- run: export → upload → fine-tune → poll → gate ----------

  /** Exports, uploads and starts the fine-tune. Returns when the provider has accepted the job. */
  async start(id: string): Promise<TrainedModel> {
    const m = await this.row(id);
    if (m.status !== "exporting") return serialize(m, null);
    try {
      const filter = m.caseFilter as CaseFilter;
      const lines: string[] = [];
      for await (const r of this.exporter.rows(m.projectId, {
        format: m.method as "sft" | "dpo",
        agent: filter.agent,
        tag: filter.tag,
        set: filter.set,
        since: filter.since,
        includeApproved: true,
        limit: 50_000,
      }))
        lines.push(JSON.stringify(r));
      await this.set(id, { status: "uploading" });
      const tg = this.together();
      const fileId = await tg.uploadFile(`${m.name}.jsonl`, `${lines.join("\n")}\n`);
      const ft = await tg.createFineTune({
        model: m.baseModel,
        trainingFile: fileId,
        suffix: m.name,
        nEpochs: m.epochs,
        method: m.method as "sft" | "dpo",
      });
      await this.set(id, { status: "training", providerFileId: fileId, providerJobId: ft.id });
    } catch (err) {
      await this.fail(id, err);
    }
    return this.get(m.projectId, id);
  }

  /** One poll of the provider. When training finishes, the gate runs. */
  async poll(id: string): Promise<TrainedModel> {
    const m = await this.row(id);
    if (m.status !== "training" || !m.providerJobId) return this.get(m.projectId, id);
    try {
      const ft = await this.together().getFineTune(m.providerJobId);
      if (!TERMINAL.has(ft.status)) return this.get(m.projectId, id);
      if (ft.status !== "completed") {
        await this.fail(id, new Error(`fine-tune ${ft.status}${ft.error ? `: ${ft.error}` : ""}`));
        return this.get(m.projectId, id);
      }
      const outputName = ft.model_output_name ?? null;
      await this.set(id, {
        status: "trained",
        outputName,
        servedAs: outputName ? `together/${outputName}` : null,
        trainingCostUsd: ft.total_price != null ? ft.total_price / 100 : null,
      });
      if (this.serving() && outputName) await this.deploy(m.projectId, id, { dryRun: false, replicas: 1 });
      else await this.gate(id);
    } catch (err) {
      await this.fail(id, err);
    }
    return this.get(m.projectId, id);
  }

  /** Runs start + polls until terminal (tests and single-process dev); the worker spaces polls out. */
  async runToCompletion(id: string, pollMs = 50, maxPolls = 10_000): Promise<TrainedModel> {
    let m = await this.start(id);
    for (let i = 0; i < maxPolls && (m.status === "training" || m.status === "deploying"); i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      m = m.status === "training" ? await this.poll(id) : await this.pollDeploy(id);
    }
    return m;
  }

  /**
   * The gate: replay the suite the model was trained on against it, step mode, and compare with
   * the model the cases were recorded with when that model has a replay on the same cases.
   * Passing means no regressions, no unaccepted new paths, and pass rate ≥ the incumbent's.
   */
  async gate(id: string): Promise<TrainedModel> {
    const m = await this.row(id);
    if (!m.servedAs) {
      await this.fail(id, new Error("trained, but the provider gave no model name to serve it by"));
      return this.get(m.projectId, id);
    }
    const { provider } = parseModel(m.servedAs);
    if (!this.registry.isConfigured(provider)) {
      await this.fail(id, new Error(`cannot gate: provider ${provider} is not configured`));
      return this.get(m.projectId, id);
    }
    await this.set(id, { status: "gating" });
    try {
      const filter = m.caseFilter as CaseFilter;
      const created = await this.replay.create(m.projectId, {
        model: m.servedAs,
        mode: "step",
        filter,
        start: true,
        examples: 0,
      });
      await this.set(id, { gateJobId: created.job.id });
      const job = await this.replay.runJob(created.job.id);
      const report = await this.replay.report(m.projectId, job.id);
      const incumbent = await this.incumbentOn(m.projectId, created.caseIds);
      const reasons = [...(report.gate?.reasons ?? [])];
      const passRate = job.summary?.passRate ?? null;
      if (incumbent && passRate != null && incumbent.passRate != null && passRate < incumbent.passRate)
        reasons.push(
          `pass rate ${(passRate * 100).toFixed(1)}% is under the incumbent's ${(incumbent.passRate * 100).toFixed(1)}% (${incumbent.model})`,
        );
      if (job.status !== "completed")
        reasons.push(`gate replay ${job.status}${job.error ? `: ${job.error}` : ""}`);
      const gate: ModelGate = {
        pass: reasons.length === 0,
        replayJobId: job.id,
        passRate,
        regressions: report.regressions.length,
        newPaths: report.newPaths?.length ?? 0,
        incumbentModel: incumbent?.model ?? null,
        incumbentPassRate: incumbent?.passRate ?? null,
        reasons,
      };
      await this.set(id, { status: gate.pass ? "passed" : "failed", gate, finishedAt: new Date() });
      await this.afterGate(m.projectId, id, gate);
    } catch (err) {
      await this.fail(id, err);
    }
    return this.get(m.projectId, id);
  }

  /** After the gate: an automatic model that passed goes to shadow (opt-in); either way the team hears. */
  private async afterGate(projectId: string, id: string, gate: ModelGate): Promise<void> {
    const m = await this.row(id);
    const settings = await this.settingsOf(projectId);
    const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
    if (gate.pass && m.trigger === "auto" && settings.retrain.shadowOnPass && m.servedAs)
      await this.set(id, { shadow: true, shadowSince: new Date() });
    const vs =
      gate.incumbentPassRate != null ? ` vs ${pct(gate.incumbentPassRate)} for ${gate.incumbentModel}` : "";
    const text = gate.pass
      ? `Owned model *${m.name}* passed the gate: pass rate ${pct(gate.passRate)}${vs}, no regressions.${
          m.trigger === "auto" && settings.retrain.shadowOnPass
            ? " Shadow mode is on; promote when the live numbers convince you."
            : " Promote when ready."
        }`
      : `Owned model *${m.name}* failed the gate: ${gate.reasons.join("; ")}.`;
    await this.notify.notifyModel(projectId, text);
  }

  private async settingsOf(projectId: string) {
    const [p] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId));
    return parseSettings(p?.settings);
  }

  // ---------- continuous retraining (opt-in) ----------

  /**
   * One sweep: for every project with retraining on, count the training rows that arrived since
   * its last automatic model; when they pass the threshold and nothing is in flight, train. The
   * model then follows the normal path — gate, dedicated endpoint, shadow — and never promotes
   * itself. Returns the ids of the models it started.
   */
  async retrainSweep(): Promise<string[]> {
    const started: string[] = [];
    const rows = await this.db.select({ id: projects.id, settings: projects.settings }).from(projects);
    for (const p of rows) {
      const settings = parseSettings(p.settings);
      const r = settings.retrain;
      if (!r.enabled || !r.baseModel) continue;
      const inFlight = await this.db
        .select({ id: trainedModels.id })
        .from(trainedModels)
        .where(
          and(
            eq(trainedModels.projectId, p.id),
            sql`${trainedModels.status} in ('exporting', 'uploading', 'training', 'deploying', 'gating')`,
          ),
        )
        .limit(1);
      if (inFlight.length > 0) continue;
      const [last] = await this.db
        .select({ createdAt: trainedModels.createdAt })
        .from(trainedModels)
        .where(and(eq(trainedModels.projectId, p.id), eq(trainedModels.trigger, "auto")))
        .orderBy(desc(trainedModels.createdAt))
        .limit(1);
      const fresh = await this.exporter.stats(p.id, {
        format: r.method,
        agent: r.agent ?? undefined,
        tag: r.tag ?? undefined,
        since: last?.createdAt.toISOString(),
        includeApproved: true,
        limit: 50_000,
      });
      if (fresh.rows < r.minNewRows) continue;
      try {
        const m = await this.create(
          p.id,
          {
            baseModel: r.baseModel,
            method: r.method,
            epochs: r.epochs,
            filter: { ...(r.agent ? { agent: r.agent } : {}), ...(r.tag ? { tag: r.tag } : {}) },
            minRows: 1,
            name: `auto-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${uuidv7().slice(-4)}`,
          },
          "auto",
        );
        started.push(m.id);
        this.logger.log(`retrain: project ${p.id} has ${fresh.rows} new rows; training ${m.name}`);
        await this.notify.notifyModel(
          p.id,
          `Retraining *${m.name}* on ${m.datasetStats?.rows ?? "?"} rows (${fresh.rows} new since the last automatic model). It will be gated and, if it passes, shadowed; nothing is promoted without a human.`,
        );
      } catch (err) {
        this.logger.warn(`retrain: project ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return started;
  }

  /** The latest completed plain replay (no examples) of the recorded model on these exact cases. */
  private async incumbentOn(
    projectId: string,
    caseIds: string[],
  ): Promise<{ model: string; passRate: number | null } | null> {
    const [c] = await this.db
      .select({ m: cases.recordedModel, p: cases.frozenInput })
      .from(cases)
      .where(eq(cases.id, caseIds[0] ?? ""))
      .limit(1);
    if (!c?.m) return null;
    const provider = (c.p as { provider?: string } | null)?.provider ?? "openai";
    const incumbent = c.m.includes("/") ? c.m : `${provider}/${c.m}`;
    const jobs = await this.db
      .select()
      .from(replayJobs)
      .where(
        and(
          eq(replayJobs.projectId, projectId),
          eq(replayJobs.status, "completed"),
          eq(replayJobs.mode, "step"),
          sql`lower(${replayJobs.targetModel}) = lower(${incumbent})`,
        ),
      )
      .orderBy(desc(replayJobs.createdAt))
      .limit(20);
    const want = [...caseIds].sort().join(",");
    const same = jobs.find((j) => {
      const ids = ((j.caseFilter as { ids?: string[] }).ids ?? []).slice().sort().join(",");
      const ex = Number((j.options as { examples?: number }).examples ?? 0);
      return ids === want && ex === 0;
    });
    return {
      model: incumbent,
      passRate: same?.summary ? (same.summary as { passRate: number }).passRate : null,
    };
  }

  // ---------- serving: a dedicated endpoint for the trained weights ----------

  /**
   * Creates the dedicated endpoint that serves a trained model (Together no longer serves LoRA
   * fine-tunes serverless): endpoint → deployment of the base model on the cheapest certified
   * hardware config → the LoRA adapter attached. Provisioning is asynchronous; `pollDeploy` runs
   * the gate once the deployment is ready. `dryRun` validates and returns the plan without
   * creating anything (nothing is billed).
   */
  async deploy(
    projectId: string,
    id: string,
    input: ModelDeployRequest,
  ): Promise<TrainedModel | ModelDeployPlan> {
    const m = await this.row(id, projectId);
    const tg = this.serving();
    if (!tg)
      throw new BadRequestException(
        "Serving needs TOGETHER_PROJECT_ID (and TOGETHER_API_KEY) on the server; or deploy the model yourself and run `overturn models serve`",
      );
    if (!m.outputName)
      throw new BadRequestException(`Model ${id} has no trained weights yet (status: ${m.status})`);
    if (m.serving && !input.dryRun)
      throw new BadRequestException(
        `Model ${id} already has an endpoint (${(m.serving as ModelServing).endpointId}); retire it first`,
      );
    const found = await tg.findModel(m.outputName);
    if (!found)
      throw new BadRequestException(
        `Together project ${tg.projectId} has no model named ${m.outputName}; is the fine-tune in this project?`,
      );
    const adapter =
      found.weights?.type === "WEIGHTS_TYPE_ADAPTER" || Boolean(found.baseModel || found.baseModelId);
    const deploys = adapter
      ? (found.baseModel ?? `projects/${found.projectId}/models/${found.baseModelId}`)
      : `projects/${found.projectId}/models/${found.id}`;
    const configs = await tg.configsFor(deploys);
    const cfg = input.config
      ? (configs.find((c) => c.id === input.config) ?? {
          id: input.config,
          projectId: tg.projectId,
          selectors: [],
          referenceModel: deploys,
          certifications: [],
        })
      : configs[0];
    if (!cfg) throw new BadRequestException(`No certified hardware config on Together for ${deploys}`);
    const configRes = `projects/${cfg.projectId}/configs/${cfg.id}`;
    const plan: ModelDeployPlan = {
      dryRun: input.dryRun,
      projectId: tg.projectId,
      togetherModel: found.name,
      adapter,
      deploys,
      config: configRes,
      hardware: cfg.selectors,
      replicas: input.replicas,
    };
    const name = `overturn-${m.name}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 60);
    const spec = {
      name,
      model: deploys,
      config: configRes,
      minReplicas: input.replicas,
      maxReplicas: input.replicas,
      inactiveTimeout: 60,
    };
    if (input.dryRun) {
      // validateOnly needs an endpoint id; Together validates the body against the project without one existing
      await tg.createDeployment("validate", spec, true).catch((err: unknown) => {
        throw new BadRequestException(
          `Together rejected the deployment: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return plan;
    }
    await this.set(id, { status: "deploying", error: null });
    try {
      const ep = await tg.createEndpoint(name);
      const dep = await tg.createDeployment(ep.id, spec);
      const ad = adapter ? await tg.attachAdapter(ep.id, dep.id, found.id) : null;
      const serving: ModelServing = {
        provider: "together",
        projectId: tg.projectId,
        endpointId: ep.id,
        deploymentId: dep.id,
        adapterId: ad?.id ?? null,
        model: deploys,
        config: configRes,
        hardware: dep.hardware ?? null,
        state: dep.status?.state ?? "DEPLOYMENT_STATE_PROVISIONING",
        replicas: input.replicas,
      };
      // what the chat API answers to: the deployment's fully-qualified name for a full model, the
      // adapter's model name when a LoRA rides on a base deployment
      await this.set(id, { serving, servedAs: `together/${adapter ? found.name : dep.name || found.name}` });
      this.logger.log(`model ${id}: endpoint ${ep.id} provisioning (${deploys} on ${configRes})`);
    } catch (err) {
      await this.fail(id, err);
    }
    return this.get(projectId, id);
  }

  /** One poll of a provisioning endpoint; runs the gate when it is ready, fails the model when it is not. */
  async pollDeploy(id: string): Promise<TrainedModel> {
    const m = await this.row(id);
    const serving = m.serving as ModelServing | null;
    const tg = this.serving();
    if (m.status !== "deploying" || !serving || !tg) return this.get(m.projectId, id);
    try {
      const dep = await tg.getDeployment(serving.endpointId, serving.deploymentId);
      const state = dep.status?.state ?? "DEPLOYMENT_STATE_PROVISIONING";
      let adapterReady = true;
      if (serving.adapterId && state === "DEPLOYMENT_STATE_READY") {
        const ad = await tg.getAdapter(serving.endpointId, serving.deploymentId, serving.adapterId);
        const states = ad.perCluster.map((c) => c.state);
        if (states.includes("ADAPTER_LOAD_STATE_FAILED"))
          throw new Error(
            `adapter failed to load: ${ad.perCluster.find((c) => c.message)?.message ?? "no detail"}`,
          );
        adapterReady = states.length > 0 && states.every((s) => s === "ADAPTER_LOAD_STATE_READY");
      }
      await this.set(id, { serving: { ...serving, state, hardware: dep.hardware ?? serving.hardware } });
      if (state === "DEPLOYMENT_STATE_FAILED" || state === "DEPLOYMENT_STATE_STOPPED")
        throw new Error(
          `endpoint ${serving.endpointId} is ${state.replace("DEPLOYMENT_STATE_", "").toLowerCase()}${dep.status?.message ? `: ${dep.status.message}` : ""}`,
        );
      if (state === "DEPLOYMENT_STATE_READY" && adapterReady) {
        await this.set(id, { status: "trained" });
        await this.gate(id);
      }
    } catch (err) {
      await this.fail(id, err);
    }
    return this.get(m.projectId, id);
  }

  /** Models whose endpoint is still provisioning (the worker polls them every minute). */
  async deploying(): Promise<string[]> {
    const rows = await this.db
      .select({ id: trainedModels.id })
      .from(trainedModels)
      .where(eq(trainedModels.status, "deploying"));
    return rows.map((r) => r.id);
  }

  /** Deletes the dedicated endpoint behind a model (stops the bill). Best effort; recorded on the row. */
  private async teardown(m: TrainedModelRow): Promise<void> {
    const serving = m.serving as ModelServing | null;
    const tg = this.serving();
    if (!serving || !tg) return;
    try {
      await tg.deleteEndpoint(serving.endpointId);
      await this.set(m.id, { serving: { ...serving, state: "DEPLOYMENT_STATE_STOPPED", replicas: 0 } });
    } catch (err) {
      this.logger.warn(
        `model ${m.id}: could not delete endpoint ${serving.endpointId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------- promote / retire / patch ----------

  async promote(projectId: string, id: string): Promise<TrainedModel> {
    const m = await this.row(id, projectId);
    if (m.status !== "passed")
      throw new BadRequestException(
        `Only a model that passed the gate can be promoted (status: ${m.status})`,
      );
    if (!m.servedAs) throw new BadRequestException("The model has no serving id; set servedAs first");
    await this.db
      .update(trainedModels)
      .set({ status: "retired" })
      .where(and(eq(trainedModels.projectId, projectId), eq(trainedModels.status, "promoted")));
    await this.set(id, { status: "promoted", promotedAt: new Date() });
    const [p] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId));
    const settings = parseSettings(p?.settings);
    await this.db
      .update(projects)
      .set({ settings: { ...settings, promotedModel: m.servedAs } })
      .where(eq(projects.id, projectId));
    return this.get(projectId, id);
  }

  async retire(projectId: string, id: string): Promise<TrainedModel> {
    const m = await this.row(id, projectId);
    await this.set(id, { status: "retired", shadow: false });
    await this.teardown(m);
    if (m.status === "promoted") {
      const [p] = await this.db
        .select({ settings: projects.settings })
        .from(projects)
        .where(eq(projects.id, projectId));
      const settings = parseSettings(p?.settings);
      if (settings.promotedModel === m.servedAs)
        await this.db
          .update(projects)
          .set({ settings: { ...settings, promotedModel: null } })
          .where(eq(projects.id, projectId));
    }
    return this.get(projectId, id);
  }

  async patch(projectId: string, id: string, body: TrainedModelPatch): Promise<TrainedModel> {
    const m = await this.row(id, projectId);
    const set: Partial<TrainedModelRow> = {};
    if (body.servedAs !== undefined) {
      parseModel(body.servedAs);
      set.servedAs = body.servedAs;
      // a model whose gate failed for want of a serving id can be gated again once it has one
      if (m.status === "failed" && m.outputName) set.status = "trained";
    }
    if (body.shadow !== undefined) {
      if (body.shadow && !m.servedAs)
        throw new BadRequestException("Shadow mode needs a serving id (servedAs)");
      set.shadow = body.shadow;
      set.shadowSince = body.shadow ? (m.shadowSince ?? new Date()) : null;
    }
    await this.set(id, set);
    if (set.status === "trained") return this.gate(id);
    return this.get(projectId, id);
  }

  // ---------- shadow mode ----------

  /**
   * Answers recent live runs with every shadow model and records what it would have said.
   * Agreement with production is known at once; agreement with humans once they correct.
   */
  async shadowSweep(limitPerModel = 25): Promise<number> {
    const models = await this.db.select().from(trainedModels).where(eq(trainedModels.shadow, true));
    let n = 0;
    for (const m of models) {
      if (!m.servedAs || !m.shadowSince) continue;
      const { provider } = parseModel(m.servedAs);
      if (!this.registry.isConfigured(provider)) continue;
      const filter = m.caseFilter as CaseFilter;
      const pending = await this.db
        .select({ id: runs.id, output: runs.output })
        .from(runs)
        .where(
          and(
            eq(runs.projectId, m.projectId),
            eq(runs.status, "completed"),
            gt(runs.endedAt, m.shadowSince),
            filter.agent ? eq(runs.agent, filter.agent) : sql`true`,
            sql`not exists (select 1 from shadow_results sr where sr.model_id = ${m.id} and sr.run_id = ${runs.id})`,
          ),
        )
        .orderBy(desc(runs.endedAt))
        .limit(limitPerModel);
      for (const r of pending) {
        n++;
        await this.shadowOne(m, r.id, r.output);
      }
    }
    return n;
  }

  private async shadowOne(m: TrainedModelRow, runId: string, productionOutput: unknown): Promise<void> {
    const [step] = await this.db
      .select()
      .from(steps)
      .where(and(eq(steps.runId, runId), eq(steps.kind, "llm_call")))
      .orderBy(desc(steps.seq))
      .limit(1);
    const base = { id: uuidv7(), projectId: m.projectId, modelId: m.id, runId };
    if (!step) {
      await this.db
        .insert(shadowResults)
        .values({ ...base, error: "run has no model step" })
        .onConflictDoNothing();
      return;
    }
    const frozen = {
      name: step.name,
      provider: step.provider,
      model: step.model,
      ...((step.input ?? {}) as Record<string, unknown>),
      params: (step.params ?? null) as Record<string, unknown> | null,
    };
    const t0 = Date.now();
    try {
      const model = this.registry.languageModel(m.servedAs!);
      const res = await this.replay.withRetry(parseModel(m.servedAs!).provider, () =>
        callModel(model, frozen),
      );
      const prodAnswer = productionOutput ?? extractAnswer(step.output);
      const fields = decisionFields(prodAnswer).fields;
      const pick = (v: unknown) =>
        fields.length && v && typeof v === "object"
          ? JSON.stringify(Object.fromEntries(fields.map((f) => [f, (v as Record<string, unknown>)[f]])))
          : JSON.stringify(v);
      await this.db
        .insert(shadowResults)
        .values({
          ...base,
          output: res.answer,
          latencyMs: Date.now() - t0,
          costUsd: null,
          agreesWithProduction: pick(res.answer) === pick(prodAnswer),
        })
        .onConflictDoNothing();
    } catch (err) {
      await this.db
        .insert(shadowResults)
        .values({
          ...base,
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - t0,
        })
        .onConflictDoNothing();
    }
  }

  /** Scores shadow answers against corrections that have arrived since. */
  async shadowScoreSweep(limit = 200): Promise<number> {
    const rows = await this.db
      .select({ sr: shadowResults, c: cases, note: corrections.note })
      .from(shadowResults)
      .innerJoin(cases, eq(cases.runId, shadowResults.runId))
      .innerJoin(corrections, eq(corrections.id, cases.correctionId))
      .where(and(isNull(shadowResults.passed), isNull(shadowResults.error), eq(cases.status, "active")))
      .limit(limit);
    let n = 0;
    for (const { sr, c, note } of rows) {
      const [p] = await this.db
        .select({ settings: projects.settings })
        .from(projects)
        .where(eq(projects.id, sr.projectId));
      const ctx = this.replay.scorerContext(sr.projectId, parseSettings(p?.settings), () => {});
      try {
        const r = await score(
          {
            scorer: c.scorer as never,
            config: (c.scorerConfig ?? {}) as Record<string, unknown>,
            expected: c.expected,
            actual: sr.output,
            kind: c.kind,
            note,
          },
          ctx,
        );
        await this.db
          .update(shadowResults)
          .set({ passed: r.passed, reason: r.reason })
          .where(eq(shadowResults.id, sr.id));
        n++;
      } catch (err) {
        this.logger.warn(`shadow score ${sr.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return n;
  }

  private async shadowStats(modelId: string): Promise<ShadowStats | null> {
    const [r] = await this.db
      .select({
        runs: sql<number>`count(*)::int`,
        agrees: sql<number>`count(*) filter (where agrees_with_production)::int`,
        scored: sql<number>`count(*) filter (where passed is not null)::int`,
        passed: sql<number>`count(*) filter (where passed)::int`,
        errors: sql<number>`count(*) filter (where error is not null)::int`,
        cost: sql<number>`coalesce(sum(cost_usd), 0)::float`,
      })
      .from(shadowResults)
      .where(eq(shadowResults.modelId, modelId));
    if (!r || r.runs === 0) return null;
    return {
      runs: r.runs,
      agreesWithProduction: r.agrees,
      scored: r.scored,
      passed: r.passed,
      passRate: r.scored ? r.passed / r.scored : null,
      errors: r.errors,
      costUsd: r.cost,
    };
  }

  // ---------- read ----------

  async list(projectId: string): Promise<TrainedModel[]> {
    const rows = await this.db
      .select()
      .from(trainedModels)
      .where(eq(trainedModels.projectId, projectId))
      .orderBy(desc(trainedModels.createdAt));
    return Promise.all(
      rows.map(async (r) => serialize(r, r.shadow || r.shadowSince ? await this.shadowStats(r.id) : null)),
    );
  }

  async get(projectId: string, id: string): Promise<TrainedModel> {
    const r = await this.row(id, projectId);
    return serialize(r, await this.shadowStats(r.id));
  }

  /** Models still training: the worker polls these. */
  async training(): Promise<string[]> {
    const rows = await this.db
      .select({ id: trainedModels.id })
      .from(trainedModels)
      .where(sql`${trainedModels.status} in ('exporting', 'training')`);
    return rows.map((r) => r.id);
  }

  private async row(id: string, projectId?: string): Promise<TrainedModelRow> {
    const [r] = await this.db
      .select()
      .from(trainedModels)
      .where(
        projectId
          ? and(eq(trainedModels.id, id), eq(trainedModels.projectId, projectId))
          : eq(trainedModels.id, id),
      )
      .limit(1);
    if (!r) throw new NotFoundException(`Model ${id} not found`);
    return r;
  }

  private async set(id: string, set: Partial<TrainedModelRow>): Promise<void> {
    await this.db.update(trainedModels).set(set).where(eq(trainedModels.id, id));
  }

  private async fail(id: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(`training ${id} failed: ${message}`);
    await this.set(id, { status: "failed", error: message, finishedAt: new Date() });
  }
}
