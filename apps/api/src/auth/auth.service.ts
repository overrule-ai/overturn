import { createHash, randomBytes } from "node:crypto";
import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { APP_CONFIG, type AppConfig } from "../config";
import type { Db } from "../db/client";
import { DB } from "../db/db.module";
import { magicLinks, memberships, organizations, projects, sessions, users } from "../db/schema";
import { slugify } from "../scripts/bootstrap";
import type { AuthContext } from "./api-keys.service";

export const SESSION_COOKIE = "ov_session";
const MAGIC_LINK_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 30 * 86_400_000;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Creates a magic link and emails it (or logs it when RESEND_API_KEY is unset). Returns the URL for tests/dev. */
  async requestMagicLink(rawEmail: string): Promise<{ sent: boolean; url: string | null }> {
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new BadRequestException("Enter a valid email address");
    const token = randomBytes(32).toString("base64url");
    await this.db.insert(magicLinks).values({
      id: uuidv7(),
      email,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    });
    const url = `${this.config.WEB_URL.replace(/\/+$/, "")}/login/verify?token=${token}`;
    if (!this.config.RESEND_API_KEY) {
      this.logger.warn(`RESEND_API_KEY not set; magic link for ${email}: ${url}`);
      return { sent: false, url };
    }
    const { Resend } = await import("resend");
    const resend = new Resend(this.config.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: this.config.EMAIL_FROM,
      to: email,
      subject: "Sign in to Overturn",
      text: `Click to sign in to Overturn (link valid for 15 minutes):\n\n${url}\n\nIf you did not request this, ignore this email.`,
    });
    if (error) throw new BadRequestException(`Could not send the email: ${error.message}`);
    return { sent: true, url: null };
  }

  /** Consumes a magic link: finds or creates the user (and a first org/project), returns a session token. */
  async verifyMagicLink(token: string): Promise<{ sessionToken: string; user: SessionUser; isNew: boolean }> {
    const [link] = await this.db
      .select()
      .from(magicLinks)
      .where(
        and(
          eq(magicLinks.tokenHash, hash(token)),
          isNull(magicLinks.consumedAt),
          gt(magicLinks.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!link) throw new UnauthorizedException("This sign-in link is invalid or has expired");
    await this.db.update(magicLinks).set({ consumedAt: new Date() }).where(eq(magicLinks.id, link.id));

    let [user] = await this.db.select().from(users).where(eq(users.email, link.email)).limit(1);
    let isNew = false;
    if (!user) {
      isNew = true;
      [user] = await this.db.insert(users).values({ id: uuidv7(), email: link.email }).returning();
    }
    if (!user) throw new Error("user creation failed");
    // Every user needs a project to land in: create a personal org + project if they have none.
    const existing = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, user.id))
      .limit(1);
    if (existing.length === 0) {
      const name = link.email.split("@")[0] ?? "me";
      const [org] = await this.db
        .insert(organizations)
        .values({ id: uuidv7(), name: `${name}'s workspace` })
        .returning();
      await this.db
        .insert(memberships)
        .values({ id: uuidv7(), organizationId: org!.id, userId: user.id, role: "owner" });
      await this.db
        .insert(projects)
        .values({ id: uuidv7(), organizationId: org!.id, name: "default", slug: slugify("default") });
    }
    const sessionToken = randomBytes(32).toString("base64url");
    await this.db.insert(sessions).values({
      id: uuidv7(),
      userId: user.id,
      tokenHash: hash(sessionToken),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    return { sessionToken, user: { id: user.id, email: user.email, name: user.name }, isNew };
  }

  async userForSession(sessionToken: string): Promise<SessionUser | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hash(sessionToken)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    return row ?? null;
  }

  async revokeSession(sessionToken: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, hash(sessionToken)));
  }

  /** Projects the user can act on, through their org memberships. */
  async projectsFor(userId: string): Promise<
    Array<{
      id: string;
      name: string;
      slug: string;
      organizationId: string;
      organizationName: string;
      role: string;
    }>
  > {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        organizationId: organizations.id,
        organizationName: organizations.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .innerJoin(projects, eq(projects.organizationId, organizations.id))
      .where(eq(memberships.userId, userId))
      .orderBy(organizations.name, projects.name);
  }

  /** AuthContext for a session user on a project they belong to (or their first project). */
  async contextFor(user: SessionUser, projectId: string | undefined): Promise<AuthContext> {
    const list = await this.projectsFor(user.id);
    const project = projectId ? list.find((p) => p.id === projectId) : list[0];
    if (!project)
      throw new UnauthorizedException(projectId ? "You are not a member of that project" : "No project");
    const [row] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, project.id))
      .limit(1);
    return {
      projectId: project.id,
      organizationId: project.organizationId,
      projectName: project.name,
      projectSlug: project.slug,
      keyId: `session:${user.id}`,
      keyPrefix: "session",
      settings: (row?.settings ?? {}) as Record<string, unknown>,
      user,
    };
  }

  async members(
    organizationId: string,
  ): Promise<Array<{ id: string; email: string; name: string | null; role: string; createdAt: string }>> {
    const rows = await this.db
      .select({
        id: memberships.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, organizationId))
      .orderBy(users.email);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /** Adds a member by email (creating the user if needed); they sign in with a magic link. */
  async addMember(organizationId: string, rawEmail: string, role = "member"): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new BadRequestException("Enter a valid email address");
    let [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) [user] = await this.db.insert(users).values({ id: uuidv7(), email }).returning();
    await this.db
      .insert(memberships)
      .values({ id: uuidv7(), organizationId, userId: user!.id, role })
      .onConflictDoNothing();
  }

  async removeMember(organizationId: string, membershipId: string, actingUserId: string): Promise<void> {
    const [m] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)))
      .limit(1);
    if (!m) throw new BadRequestException("Member not found");
    if (m.userId === actingUserId) throw new BadRequestException("You cannot remove yourself");
    await this.db.delete(memberships).where(eq(memberships.id, membershipId));
  }
}
