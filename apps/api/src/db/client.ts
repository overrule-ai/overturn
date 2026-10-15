import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof postgres>;

export function createDb(url: string, options: { max?: number } = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    // jsonb round-trips as objects; dates as Date
    transform: { undefined: null },
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
