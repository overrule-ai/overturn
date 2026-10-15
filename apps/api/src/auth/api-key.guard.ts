import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ApiKeysService, type AuthContext } from "./api-keys.service";

export type AuthedRequest = FastifyRequest & { auth?: AuthContext };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.auth) return true;
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    const key =
      scheme?.toLowerCase() === "bearer" && token ? token : (req.headers["x-api-key"] as string | undefined);
    if (!key) throw new UnauthorizedException("Missing API key: send `Authorization: Bearer ov_live_…`");
    const auth = await this.keys.authenticate(key.trim());
    if (!auth) throw new UnauthorizedException("Invalid or revoked API key");
    req.auth = auth;
    return true;
  }
}

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
});
