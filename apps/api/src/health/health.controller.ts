import { Controller, Get, Inject, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { Sql } from "../db/client";
import { SQL } from "../db/db.module";
import { buildOpenApi } from "../openapi/openapi";

@Controller()
export class HealthController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Get("openapi.json")
  openapi(@Req() req: FastifyRequest): Record<string, unknown> {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
    const host = req.headers.host;
    return buildOpenApi(host ? `${proto}://${host}` : undefined);
  }

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
