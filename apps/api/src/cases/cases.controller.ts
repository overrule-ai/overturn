import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type Case,
  type CaseListQuery,
  type CasePatch,
  type CaseSet,
  type CaseSetCreate,
  type CaseSummary,
  caseListQuerySchema,
  casePatchSchema,
  caseSetCreateSchema,
  type Page,
} from "@overturn-ai/shared";
import { z } from "zod";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import { CasesService } from "./cases.service";

@Controller("v1")
@UseGuards(ApiKeyGuard)
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get("cases")
  list(
    @Auth() auth: AuthContext,
    @Query(zod(caseListQuerySchema)) q: CaseListQuery,
  ): Promise<Page<CaseSummary>> {
    return this.cases.list(auth.projectId, q);
  }

  @Get("cases/:id")
  get(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<Case> {
    return this.cases.get(auth.projectId, id);
  }

  /** Result history across replay jobs, newest first. */
  @Get("cases/:id/results")
  results(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string) {
    return this.cases.results(auth.projectId, id);
  }

  @Patch("cases/:id")
  patch(
    @Auth() auth: AuthContext,
    @Param("id", zod(z.uuid())) id: string,
    @Body(zod(casePatchSchema)) body: CasePatch,
  ): Promise<Case> {
    return this.cases.patch(auth.projectId, id, body);
  }

  @Get("case-sets")
  listSets(@Auth() auth: AuthContext): Promise<CaseSet[]> {
    return this.cases.listSets(auth.projectId);
  }

  @Post("case-sets")
  @HttpCode(201)
  createSet(
    @Auth() auth: AuthContext,
    @Body(zod(caseSetCreateSchema)) body: CaseSetCreate,
  ): Promise<CaseSet> {
    return this.cases.createSet(auth.projectId, body);
  }

  @Delete("case-sets/:id")
  @HttpCode(204)
  async deleteSet(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<void> {
    await this.cases.deleteSet(auth.projectId, id);
  }
}
