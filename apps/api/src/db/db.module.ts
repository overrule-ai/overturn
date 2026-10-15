import { Global, Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { createDb, type Db, type Sql } from "./client";

export const DB = Symbol("DB");
export const SQL = Symbol("SQL");

@Injectable()
export class DbLifecycle implements OnModuleDestroy {
  constructor(@Inject(SQL) private readonly sql: Sql) {}
  async onModuleDestroy(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: "DB_BUNDLE",
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createDb(config.DATABASE_URL),
    },
    { provide: DB, inject: ["DB_BUNDLE"], useFactory: (b: { db: Db }) => b.db },
    { provide: SQL, inject: ["DB_BUNDLE"], useFactory: (b: { sql: Sql }) => b.sql },
    DbLifecycle,
  ],
  exports: [DB, SQL],
})
export class DbModule {}
