import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import {
  INGEST_VERSION,
  type IngestPayload,
  type IngestResponse,
  ingestPayloadSchema,
} from "@overturn/shared";
import { z } from "zod";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import { IngestService } from "./ingest.service";

const versionProbe = z.object({ v: z.unknown() }).loose();

@Controller("v1/ingest")
@UseGuards(ApiKeyGuard)
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post()
  @HttpCode(202)
  async post(@Auth() auth: AuthContext, @Body(zod(versionProbe)) raw: unknown): Promise<IngestResponse> {
    const { v } = raw as { v: unknown };
    if (v !== INGEST_VERSION) {
      throw new BadRequestException({
        message: `Unsupported ingest payload version ${JSON.stringify(v)}; this server accepts v=${INGEST_VERSION}. Upgrade the SDK or the server.`,
      });
    }
    const payload: IngestPayload = zod(ingestPayloadSchema).transform(raw);
    return this.ingest.ingest(auth.projectId, payload);
  }
}
