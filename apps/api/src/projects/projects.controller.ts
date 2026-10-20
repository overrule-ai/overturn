import { Body, Controller, Get, Inject, NotFoundException, Patch, Post, UseGuards } from "@nestjs/common";
import {
  type Project,
  type ProjectPatch,
  projectPatchSchema,
  projectSettingsSchema,
} from "@overturn-ai/shared";
import { eq } from "drizzle-orm";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { zod } from "../common/zod.pipe";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { type ProjectRow, projects } from "../db/schema";
import { NotifyService } from "../notify/notify.service";
import { parseSettings } from "./settings";

export function serializeProject(p: ProjectRow): Project {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    settings: parseSettings(p.settings),
    createdAt: p.createdAt.toISOString(),
  };
}

@Controller("v1/project")
@UseGuards(ApiKeyGuard)
export class ProjectsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notify: NotifyService,
  ) {}

  /** Posts a sample message to the configured review webhook. */
  @Post("webhook-test")
  async webhookTest(@Auth() auth: AuthContext): Promise<{ ok: boolean; status?: number; error?: string }> {
    return this.notify.sendTest(auth.projectId);
  }

  @Get()
  async get(@Auth() auth: AuthContext): Promise<Project> {
    const [p] = await this.db.select().from(projects).where(eq(projects.id, auth.projectId)).limit(1);
    if (!p) throw new NotFoundException();
    return serializeProject(p);
  }

  @Patch()
  async patch(
    @Auth() auth: AuthContext,
    @Body(zod(projectPatchSchema)) body: ProjectPatch,
  ): Promise<Project> {
    const [p] = await this.db.select().from(projects).where(eq(projects.id, auth.projectId)).limit(1);
    if (!p) throw new NotFoundException();
    const settings = projectSettingsSchema.parse({ ...parseSettings(p.settings), ...(body.settings ?? {}) });
    const [updated] = await this.db
      .update(projects)
      .set({ name: body.name ?? p.name, settings })
      .where(eq(projects.id, p.id))
      .returning();
    return serializeProject(updated!);
  }
}
