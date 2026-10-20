import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { zod } from "../common/zod.pipe";
import { APP_CONFIG, type AppConfig } from "../config";
import { ApiKeyGuard, Auth, type AuthedRequest } from "./api-key.guard";
import { ApiKeysService, type AuthContext } from "./api-keys.service";
import { AuthService, SESSION_COOKIE } from "./auth.service";
import { RateLimiter } from "./rate-limit";

// magic links send email: 5 per address and 30 per client IP, per 10 minutes
const byEmail = new RateLimiter(5, 10 * 60_000);
const byIp = new RateLimiter(30, 10 * 60_000);

const emailSchema = z.object({ email: z.string().min(3).max(320) });
const keyCreateSchema = z.object({ name: z.string().min(1).max(100).default("default") });
const memberCreateSchema = z.object({
  email: z.string().min(3).max(320),
  role: z.enum(["owner", "member"]).default("member"),
});

type CookieReply = FastifyReply & {
  setCookie: (name: string, value: string, opts: Record<string, unknown>) => FastifyReply;
  clearCookie: (name: string, opts?: Record<string, unknown>) => FastifyReply;
};

@Controller("v1")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly keys: ApiKeysService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private cookieOptions(): Record<string, unknown> {
    const secure = this.config.WEB_URL.startsWith("https://");
    return { path: "/", httpOnly: true, sameSite: secure ? "none" : "lax", secure, maxAge: 30 * 86_400 };
  }

  /** Step 1: request a sign-in link. In dev (no RESEND_API_KEY) the link is returned in the response. */
  @Post("auth/magic-link")
  @HttpCode(200)
  async magicLink(
    @Body(zod(emailSchema)) body: z.infer<typeof emailSchema>,
    @Req() req: FastifyRequest,
  ): Promise<{ sent: boolean; devUrl: string | null }> {
    if (!byIp.allow(req.ip) || !byEmail.allow(body.email.toLowerCase())) {
      throw new HttpException(
        { message: "Too many sign-in links requested; try again in a few minutes." },
        429,
      );
    }
    const r = await this.auth.requestMagicLink(body.email);
    return { sent: r.sent, devUrl: r.url };
  }

  /** Step 2: the web app posts the token from the link; the API sets the session cookie. */
  @Post("auth/verify")
  @HttpCode(200)
  async verify(
    @Body(zod(z.object({ token: z.string().min(10) }))) body: { token: string },
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    const r = await this.auth.verifyMagicLink(body.token);
    reply.setCookie(SESSION_COOKIE, r.sessionToken, this.cookieOptions());
    return { user: r.user, isNew: r.isNew };
  }

  @Post("auth/logout")
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: CookieReply): Promise<void> {
    const token = (req as { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
    if (token) await this.auth.revokeSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  /** Who am I (session) and which projects can I open. */
  @Get("auth/session")
  @UseGuards(ApiKeyGuard)
  async session(@Auth() auth: AuthContext, @Req() req: AuthedRequest) {
    const projects = auth.user
      ? await this.auth.projectsFor(auth.user.id)
      : [
          {
            id: auth.projectId,
            name: auth.projectName,
            slug: auth.projectSlug,
            organizationId: auth.organizationId,
            organizationName: "",
            role: "api-key",
          },
        ];
    return {
      user: auth.user ?? null,
      project: {
        id: auth.projectId,
        name: auth.projectName,
        slug: auth.projectSlug,
        organizationId: auth.organizationId,
      },
      projects,
      via: req.auth?.user ? "session" : "api-key",
    };
  }

  // ---- API keys ----

  @Get("api-keys")
  @UseGuards(ApiKeyGuard)
  listKeys(@Auth() auth: AuthContext) {
    return this.keys.list(auth.projectId);
  }

  @Post("api-keys")
  @UseGuards(ApiKeyGuard)
  @HttpCode(201)
  createKey(@Auth() auth: AuthContext, @Body(zod(keyCreateSchema)) body: z.infer<typeof keyCreateSchema>) {
    return this.keys.create(auth.projectId, body.name);
  }

  @Delete("api-keys/:id")
  @UseGuards(ApiKeyGuard)
  @HttpCode(204)
  async revokeKey(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<void> {
    await this.keys.revoke(auth.projectId, id);
  }

  // ---- members ----

  @Get("members")
  @UseGuards(ApiKeyGuard)
  members(@Auth() auth: AuthContext) {
    return this.auth.members(auth.organizationId);
  }

  @Post("members")
  @UseGuards(ApiKeyGuard)
  @HttpCode(201)
  async addMember(
    @Auth() auth: AuthContext,
    @Body(zod(memberCreateSchema)) body: z.infer<typeof memberCreateSchema>,
  ) {
    await this.auth.addMember(auth.organizationId, body.email, body.role);
    return this.auth.members(auth.organizationId);
  }

  @Delete("members/:id")
  @UseGuards(ApiKeyGuard)
  @HttpCode(204)
  async removeMember(@Auth() auth: AuthContext, @Param("id", zod(z.uuid())) id: string): Promise<void> {
    await this.auth.removeMember(auth.organizationId, id, auth.user?.id ?? "");
  }

  /** Convenience for the web app's project switcher. */
  @Get("projects")
  @UseGuards(ApiKeyGuard)
  async projects(@Auth() auth: AuthContext, @Query("all") _all?: string) {
    return auth.user
      ? this.auth.projectsFor(auth.user.id)
      : [
          {
            id: auth.projectId,
            name: auth.projectName,
            slug: auth.projectSlug,
            organizationId: auth.organizationId,
            organizationName: "",
            role: "api-key",
          },
        ];
  }
}
