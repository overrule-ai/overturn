import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  type PromptVersion,
  type PromptVersionCreate,
  promptVersionCreateSchema,
  type ReplayCreate,
  type ReplayEstimate,
  type ReplayJob,
  type ReplayModelCallRequest,
  type ReplayModelCallResponse,
  type ReplayReport,
  type ReplayResult,
  type ReplayResultsPost,
  renderMarkdownReport,
  replayCreateSchema,
  replayListQuerySchema,
  replayModelCallSchema,
  replayResultsPostSchema,
} from "@overturn-ai/shared";
import { z } from "zod";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import { JobsService } from "../jobs/jobs.service";
import { PromptsService } from "./prompts.service";
import { ReplayService } from "./replay.service";

const estimateSchema = replayCreateSchema.pick({ model: true, filter: true });

@Controller("v1")
@UseGuards(ApiKeyGuard)
export class ReplayController {
  constructor(
    private readonly replay: ReplayService,
    private readonly prompts: PromptsService,
    private readonly jobs: JobsService,
  ) {}

  @Post("replays/estimate")
  estimate(
    @Auth() auth: AuthContext,
    @Body(zod(estimateSchema)) body: z.infer<typeof estimateSchema>,
  ): Promise<ReplayEstimate> {
    return this.replay.estimate(auth.projectId, body.model, body.filter);
  }

  @Post("replays")
  @HttpCode(201)
  async create(
    @Auth() auth: AuthContext,
    @Body(zod(replayCreateSchema)) body: ReplayCreate,
  ): Promise<{ job: ReplayJob; estimate: ReplayEstimate; caseIds: string[] }> {
    const created = await this.replay.create(auth.projectId, body);
    if (body.start && body.mode === "step") await this.jobs.enqueueReplay(created.job.id);
    return created;
  }

  @Get("replays")
  list(
    @Auth() auth: AuthContext,
    @Query(zod(replayListQuerySchema)) q: z.infer<typeof replayListQuerySchema>,
  ): Promise<ReplayJob[]> {
    return this.replay.list(auth.projectId, q);
  }

  @Get("replays/:id")
  get(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<ReplayJob> {
    return this.replay.get(auth.projectId, id);
  }

  @Post("replays/:id/cancel")
  cancel(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<ReplayJob> {
    return this.replay.cancel(auth.projectId, id);
  }

  @Get("replays/:id/results")
  results(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<ReplayResult[]> {
    return this.replay.results(auth.projectId, id);
  }

  @Post("replays/:id/results")
  @HttpCode(200)
  postResults(
    @Auth() auth: AuthContext,
    @Param("id", zod(z.uuid())) id: string,
    @Body(zod(replayResultsPostSchema)) body: ReplayResultsPost,
  ): Promise<ReplayJob> {
    return this.replay.postResults(auth.projectId, id, body);
  }

  @Post("replays/model")
  @HttpCode(200)
  modelCall(
    @Auth() auth: AuthContext,
    @Body(zod(replayModelCallSchema)) body: ReplayModelCallRequest,
  ): Promise<ReplayModelCallResponse> {
    return this.replay.modelCall(auth.projectId, body);
  }

  @Get("replays/:id/report")
  report(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<ReplayReport> {
    return this.replay.report(auth.projectId, id);
  }

  @Get("replays/:id/report.md")
  @Header("content-type", "text/markdown; charset=utf-8")
  async reportMarkdown(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<string> {
    return renderMarkdownReport(await this.replay.report(auth.projectId, id));
  }

  @Post("prompts")
  @HttpCode(201)
  registerPrompt(
    @Auth() auth: AuthContext,
    @Body(zod(promptVersionCreateSchema)) body: PromptVersionCreate,
  ): Promise<PromptVersion> {
    return this.prompts.register(auth.projectId, body);
  }

  @Get("prompts")
  listPrompts(@Auth() auth: AuthContext, @Query("name") name?: string): Promise<PromptVersion[]> {
    return this.prompts.list(auth.projectId, name);
  }
}
