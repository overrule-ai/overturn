import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { type ExportQuery, type ExportStats, exportQuerySchema } from "@overturn-ai/shared";
import type { FastifyReply } from "fastify";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import { ExportService } from "./export.service";

@Controller("v1")
@UseGuards(ApiKeyGuard)
export class ExportController {
  constructor(private readonly exporter: ExportService) {}

  /** What the export would contain: rows per kind, rough token count. */
  @Get("export/stats")
  stats(@Auth() auth: AuthContext, @Query(zod(exportQuerySchema)) q: ExportQuery): Promise<ExportStats> {
    return this.exporter.stats(auth.projectId, q);
  }

  /** The project's corrections as a fine-tuning dataset, one JSON object per line. */
  @Get("export")
  async export(
    @Auth() auth: AuthContext,
    @Query(zod(exportQuerySchema)) q: ExportQuery,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const lines: string[] = [];
    for await (const row of this.exporter.rows(auth.projectId, q)) lines.push(JSON.stringify(row));
    reply
      .header("content-type", "application/jsonl; charset=utf-8")
      .header("content-disposition", `attachment; filename="overturn-${q.format}.jsonl"`)
      .header("x-overturn-rows", String(lines.length))
      .send(lines.length ? `${lines.join("\n")}\n` : "");
  }
}
