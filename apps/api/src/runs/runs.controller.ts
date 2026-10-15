import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  type Page,
  type Run,
  type RunListQuery,
  type RunWithSteps,
  runListQuerySchema,
} from "@overturn/shared";
import { z } from "zod";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import { RunsService } from "./runs.service";

@Controller("v1/runs")
@UseGuards(ApiKeyGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query(zod(runListQuerySchema)) q: RunListQuery): Promise<Page<Run>> {
    return this.runs.list(auth.projectId, q);
  }

  @Get("stats")
  stats(@Auth() auth: AuthContext) {
    return this.runs.stats(auth.projectId);
  }

  @Get(":id")
  get(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<RunWithSteps> {
    return this.runs.get(auth.projectId, id);
  }
}
