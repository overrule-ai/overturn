import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { type CaptureCreate, type CaptureResult, captureCreateSchema } from "@overturn-ai/shared";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import { CaptureService } from "./capture.service";

@Controller("v1/capture")
@UseGuards(ApiKeyGuard)
export class CaptureController {
  constructor(private readonly capture: CaptureService) {}

  /** Draft vs sent from the tool the expert works in: one call, a case comes out. */
  @Post()
  @HttpCode(201)
  create(
    @Auth() auth: AuthContext,
    @Body(zod(captureCreateSchema)) body: CaptureCreate,
  ): Promise<CaptureResult> {
    return this.capture.create(auth.projectId, { ...body, actor: body.actor ?? auth.user?.email ?? null });
  }
}
