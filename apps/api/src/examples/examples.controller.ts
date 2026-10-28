import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { type ExamplesQuery, type ExamplesResponse, examplesQuerySchema } from "@overturn-ai/shared";
import { sql } from "drizzle-orm";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { parseSettings } from "../projects/settings";
import { ReplayService } from "../replay/replay.service";
import { ExamplesService } from "./examples.service";

@Controller("v1")
@UseGuards(ApiKeyGuard)
export class ExamplesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly examples: ExamplesService,
    private readonly replay: ReplayService,
  ) {}

  /**
   * Corrections in the prompt: the k human-approved cases nearest to an input, with a block
   * ready to append to the system prompt. The SDKs call this from production agents.
   */
  @Get("examples")
  async get(
    @Auth() auth: AuthContext,
    @Query(zod(examplesQuerySchema)) q: ExamplesQuery,
  ): Promise<ExamplesResponse> {
    const [row] = await this.db.execute(sql`select settings from projects where id = ${auth.projectId}`);
    const settings = parseSettings((row as { settings?: unknown } | undefined)?.settings);
    const ctx = this.replay.scorerContext(auth.projectId, settings, () => {});
    return this.examples.forInput(auth.projectId, q, this.replay.examplesContext(settings, ctx));
  }
}
