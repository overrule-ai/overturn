import { Controller, Get, Inject } from "@nestjs/common";
import type { Sql } from "../db/client";
import { SQL } from "../db/db.module";

@Controller()
export class HealthController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Get("health")
  async health(): Promise<{ ok: boolean; db: boolean; version: string }> {
    let db = false;
    try {
      await this.sql`select 1`;
      db = true;
    } catch {
      db = false;
    }
    return { ok: db, db, version: "0.1.0" };
  }
}
