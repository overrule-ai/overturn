import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PromptVersion, PromptVersionCreate } from "@overturn/shared";
import { and, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { promptVersions } from "../db/schema";

function serialize(r: typeof promptVersions.$inferSelect): PromptVersion {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    template: r.template,
    hash: r.hash,
    createdAt: r.createdAt.toISOString(),
  };
}

@Injectable()
export class PromptsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Upsert by (name, version): re-registering the same version with new text replaces it. */
  async register(projectId: string, input: PromptVersionCreate): Promise<PromptVersion> {
    const hash = createHash("sha256").update(input.template).digest("hex");
    const [row] = await this.db
      .insert(promptVersions)
      .values({
        id: uuidv7(),
        projectId,
        name: input.name,
        version: input.version,
        template: input.template,
        hash,
      })
      .onConflictDoUpdate({
        target: [promptVersions.projectId, promptVersions.name, promptVersions.version],
        set: { template: input.template, hash },
      })
      .returning();
    return serialize(row!);
  }

  async list(projectId: string, name?: string): Promise<PromptVersion[]> {
    const where = [eq(promptVersions.projectId, projectId)];
    if (name) where.push(eq(promptVersions.name, name));
    const rows = await this.db
      .select()
      .from(promptVersions)
      .where(and(...where))
      .orderBy(promptVersions.name, desc(promptVersions.createdAt));
    return rows.map(serialize);
  }

  /** "name@version" -> prompt version. */
  async resolve(projectId: string, ref: string): Promise<PromptVersion> {
    const at = ref.lastIndexOf("@");
    if (at <= 0) throw new NotFoundException(`Prompt reference must be name@version, got "${ref}"`);
    const name = ref.slice(0, at);
    const version = ref.slice(at + 1);
    const [row] = await this.db
      .select()
      .from(promptVersions)
      .where(
        and(
          eq(promptVersions.projectId, projectId),
          eq(promptVersions.name, name),
          eq(promptVersions.version, version),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException(`Prompt version "${ref}" is not registered (POST /v1/prompts)`);
    return serialize(row);
  }
}
