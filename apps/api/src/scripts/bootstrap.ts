/**
 * Creates (or reuses) an organization, user, project and prints a fresh API key.
 *
 *   pnpm bootstrap --email you@example.com --org "Acme" --project "default"
 *
 * Idempotent on (email, org, project); always mints a new key.
 */
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ApiKeysService } from "../auth/api-keys.service";
import { createDb } from "../db/client";
import { memberships, organizations, projects, users } from "../db/schema";
import { loadDotEnv } from "../env";

export interface BootstrapResult {
  organizationId: string;
  userId: string;
  projectId: string;
  apiKey: string;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

export async function bootstrap(
  databaseUrl: string,
  opts: { email: string; org: string; project: string; keyName?: string },
): Promise<BootstrapResult> {
  const { db, sql } = createDb(databaseUrl, { max: 1 });
  try {
    const email = opts.email.toLowerCase();
    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      [user] = await db.insert(users).values({ id: uuidv7(), email }).returning();
    }
    if (!user) throw new Error("failed to create user");

    // Find an org with this name the user belongs to, else create it.
    const owned = await db
      .select({ org: organizations })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(and(eq(memberships.userId, user.id), eq(organizations.name, opts.org)))
      .limit(1);
    let org = owned[0]?.org;
    if (!org) {
      [org] = await db.insert(organizations).values({ id: uuidv7(), name: opts.org }).returning();
      if (!org) throw new Error("failed to create organization");
      await db
        .insert(memberships)
        .values({ id: uuidv7(), organizationId: org.id, userId: user.id, role: "owner" });
    }

    const slug = slugify(opts.project);
    let [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, org.id), eq(projects.slug, slug)))
      .limit(1);
    if (!project) {
      [project] = await db
        .insert(projects)
        .values({ id: uuidv7(), organizationId: org.id, name: opts.project, slug })
        .returning();
    }
    if (!project) throw new Error("failed to create project");

    const keys = new ApiKeysService(db);
    const { key } = await keys.create(project.id, opts.keyName ?? "bootstrap");
    return { organizationId: org.id, userId: user.id, projectId: project.id, apiKey: key };
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  loadDotEnv();
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      email: { type: "string", default: "dev@example.com" },
      org: { type: "string", default: "Dev" },
      project: { type: "string", default: "default" },
      json: { type: "boolean", default: false },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  bootstrap(url, { email: values.email!, org: values.org!, project: values.project! })
    .then((r) => {
      if (values.json) {
        console.log(JSON.stringify(r));
      } else {
        console.log(`Project: ${r.projectId}`);
        console.log(`API key (shown once):\n\n  OVERTURN_API_KEY=${r.apiKey}\n`);
      }
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
