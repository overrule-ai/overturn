import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import {
  type Correction,
  type CorrectionCreate,
  type CorrectionResult,
  correctionCreateSchema,
  correctionListQuerySchema,
} from "@overturn-ai/shared";
import type { z } from "zod";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import { CorrectionsService } from "./corrections.service";

@Controller("v1/corrections")
@UseGuards(ApiKeyGuard)
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post()
  @HttpCode(201)
  create(
    @Auth() auth: AuthContext,
    @Body(zod(correctionCreateSchema)) body: CorrectionCreate,
  ): Promise<CorrectionResult> {
    // Corrections made from the web app are attributed to the signed-in user unless an actor is given.
    const actor = body.actor ?? auth.user?.email ?? null;
    return this.corrections.create(auth.projectId, {
      ...body,
      actor,
      source: auth.user ? "ui" : body.source,
    });
  }

  @Get()
  list(
    @Auth() auth: AuthContext,
    @Query(zod(correctionListQuerySchema)) q: z.infer<typeof correctionListQuerySchema>,
  ): Promise<Correction[]> {
    return this.corrections.list(auth.projectId, q);
  }
}
