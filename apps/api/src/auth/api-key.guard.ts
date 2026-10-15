import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ApiKeysService, type AuthContext } from "./api-keys.service";
import { AuthService, SESSION_COOKIE } from "./auth.service";

export type AuthedRequest = FastifyRequest & { auth?: AuthContext };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly sessionsAuth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.auth) return true;
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    const key =
      scheme?.toLowerCase() === "bearer" && token ? token : (req.headers["x-api-key"] as string | undefined);
    if (key) {
      const auth = await this.keys.authenticate(key.trim());
      if (!auth) throw new UnauthorizedException("Invalid or revoked API key");
      req.auth = auth;
      return true;
    }
    // Web app: session cookie + optional x-overturn-project header
    const cookie = (req as { cookies?: Record<string, string | undefined> }).cookies?.[SESSION_COOKIE];
    if (cookie) {
      const user = await this.sessionsAuth.userForSession(cookie);
      if (!user) throw new UnauthorizedException("Your session has expired; sign in again");
      const projectHeader = req.headers["x-overturn-project"];
      req.auth = await this.sessionsAuth.contextFor(
        user,
        typeof projectHeader === "string" ? projectHeader : undefined,
      );
      return true;
    }
    throw new UnauthorizedException("Missing API key: send `Authorization: Bearer ov_live_…`");
  }
}

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
});
