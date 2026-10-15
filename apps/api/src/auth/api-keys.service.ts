import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { apiKeys, organizations, projects } from "../db/schema";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const KEY_PREFIX = "ov_live_";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): string {
  const bytes = randomBytes(32);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return KEY_PREFIX + out;
}

export interface AuthContext {
  projectId: string;
  organizationId: string;
  projectName: string;
  projectSlug: string;
  keyId: string;
  keyPrefix: string;
  settings: Record<string, unknown>;
}

@Injectable()
export class ApiKeysService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Creates a key, returns the plaintext once. */
  async create(projectId: string, name = "default"): Promise<{ id: string; key: string; prefix: string }> {
    const key = generateApiKey();
    const id = uuidv7();
    const prefix = key.slice(0, KEY_PREFIX.length + 6);
    await this.db.insert(apiKeys).values({ id, projectId, name, prefix, hash: hashApiKey(key) });
    return { id, key, prefix };
  }

  async list(projectId: string) {
    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.projectId, projectId));
  }

  async revoke(projectId: string, keyId: string): Promise<boolean> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.projectId, projectId), eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
  }

  async authenticate(key: string): Promise<AuthContext | null> {
    if (!key.startsWith(KEY_PREFIX)) return null;
    const rows = await this.db
      .select({
        keyId: apiKeys.id,
        keyPrefix: apiKeys.prefix,
        revokedAt: apiKeys.revokedAt,
        projectId: projects.id,
        projectName: projects.name,
        projectSlug: projects.slug,
        settings: projects.settings,
        organizationId: organizations.id,
      })
      .from(apiKeys)
      .innerJoin(projects, eq(projects.id, apiKeys.projectId))
      .innerJoin(organizations, eq(organizations.id, projects.organizationId))
      .where(eq(apiKeys.hash, hashApiKey(key)))
      .limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return null;
    // fire-and-forget last_used_at
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.keyId))
      .catch(() => {});
    return {
      projectId: row.projectId,
      organizationId: row.organizationId,
      projectName: row.projectName,
      projectSlug: row.projectSlug,
      keyId: row.keyId,
      keyPrefix: row.keyPrefix,
      settings: (row.settings ?? {}) as Record<string, unknown>,
    };
  }
}
