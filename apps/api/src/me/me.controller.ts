import { Controller, Get, UseGuards } from "@nestjs/common";
import type { MeResponse } from "@overturn/shared";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";

@Controller("v1/me")
@UseGuards(ApiKeyGuard)
export class MeController {
  @Get()
  me(@Auth() auth: AuthContext): MeResponse {
    return {
      project: { id: auth.projectId, name: auth.projectName, slug: auth.projectSlug },
      organization: { id: auth.organizationId, name: "" },
      keyPrefix: auth.keyPrefix,
    };
  }
}
