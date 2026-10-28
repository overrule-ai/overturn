import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import {
  type ModelDeployPlan,
  type ModelDeployRequest,
  modelDeployRequestSchema,
  type TrainCreate,
  type TrainedModel,
  type TrainedModelPatch,
  trainCreateSchema,
  trainedModelPatchSchema,
} from "@overturn-ai/shared";
import { z } from "zod";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import { JobsService } from "../jobs/jobs.service";
import { TrainingService } from "./training.service";

@Controller("v1")
@UseGuards(ApiKeyGuard)
export class TrainingController {
  constructor(
    private readonly training: TrainingService,
    private readonly jobs: JobsService,
  ) {}

  /** Train an open-weight model on the project's corrections; the suite gates it when training ends. */
  @Post("models")
  @HttpCode(201)
  async create(
    @Auth() auth: AuthContext,
    @Body(zod(trainCreateSchema)) body: TrainCreate,
  ): Promise<TrainedModel> {
    const m = await this.training.create(auth.projectId, body);
    await this.jobs.enqueueTraining(m.id);
    return m;
  }

  @Get("models")
  list(@Auth() auth: AuthContext): Promise<TrainedModel[]> {
    return this.training.list(auth.projectId);
  }

  @Get("models/:id")
  get(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<TrainedModel> {
    return this.training.get(auth.projectId, id);
  }

  /** Set where the weights answer from (when the provider needs a dedicated endpoint) or toggle shadow mode. */
  @Patch("models/:id")
  patch(
    @Auth() auth: AuthContext,
    @Param("id", zod(z.uuid())) id: string,
    @Body(zod(trainedModelPatchSchema)) body: TrainedModelPatch,
  ): Promise<TrainedModel> {
    return this.training.patch(auth.projectId, id, body);
  }

  /** A human's decision. Only a model that passed the gate can be promoted. */
  @Post("models/:id/promote")
  promote(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<TrainedModel> {
    return this.training.promote(auth.projectId, id);
  }

  @Post("models/:id/deploy")
  @HttpCode(200)
  deploy(
    @Auth() auth: AuthContext,
    @Param("id", zod(z.uuid())) id: string,
    @Body(zod(modelDeployRequestSchema)) body: ModelDeployRequest,
  ): Promise<TrainedModel | ModelDeployPlan> {
    return this.training.deploy(auth.projectId, id, body);
  }

  @Post("models/:id/retire")
  retire(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<TrainedModel> {
    return this.training.retire(auth.projectId, id);
  }
}
