import { type DynamicModule, Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { APP_CONFIG, type AppConfig, loadConfig } from "./config";
import { DbModule } from "./db/db.module";
import { HealthController } from "./health/health.controller";
import { IngestController } from "./ingest/ingest.controller";
import { IngestService } from "./ingest/ingest.service";
import { MeController } from "./me/me.controller";
import { RunsController } from "./runs/runs.controller";
import { RunsService } from "./runs/runs.service";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      imports: [DbModule, AuthModule],
      controllers: [HealthController, MeController, IngestController, RunsController],
      providers: [{ provide: APP_CONFIG, useValue: config }, IngestService, RunsService],
      exports: [APP_CONFIG],
      global: true,
    };
  }
}
