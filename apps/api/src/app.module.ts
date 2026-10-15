import { type DynamicModule, Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { CasesController } from "./cases/cases.controller";
import { CasesService } from "./cases/cases.service";
import { APP_CONFIG, type AppConfig, loadConfig } from "./config";
import { CorrectionsController } from "./corrections/corrections.controller";
import { CorrectionsService } from "./corrections/corrections.service";
import { DbModule } from "./db/db.module";
import { HealthController } from "./health/health.controller";
import { IngestController } from "./ingest/ingest.controller";
import { IngestService } from "./ingest/ingest.service";
import { JobsService } from "./jobs/jobs.service";
import { MeController } from "./me/me.controller";
import { OtlpController } from "./otlp/otlp.controller";
import { ProjectsController } from "./projects/projects.controller";
import { RunsController } from "./runs/runs.controller";
import { RunsService } from "./runs/runs.service";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      imports: [DbModule, AuthModule],
      controllers: [
        HealthController,
        MeController,
        ProjectsController,
        IngestController,
        OtlpController,
        RunsController,
        CorrectionsController,
        CasesController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        IngestService,
        RunsService,
        CasesService,
        CorrectionsService,
        JobsService,
      ],
      exports: [APP_CONFIG],
      global: true,
    };
  }
}
