import { Global, Module } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeysService } from "./api-keys.service";
import { AuthService } from "./auth.service";

@Global()
@Module({
  providers: [ApiKeysService, AuthService, ApiKeyGuard],
  exports: [ApiKeysService, AuthService, ApiKeyGuard],
})
export class AuthModule {}
