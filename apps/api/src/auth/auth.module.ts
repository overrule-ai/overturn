import { Global, Module } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeysService } from "./api-keys.service";

@Global()
@Module({
  providers: [ApiKeysService, ApiKeyGuard],
  exports: [ApiKeysService, ApiKeyGuard],
})
export class AuthModule {}
