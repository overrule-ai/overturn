import postgres from "postgres";
import { runMigrations } from "../db/migrate";

export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/overturn_test";

/** Creates the database named in `url` if it does not exist (needs a server the user can reach). */
export async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const dbName = u.pathname.replace(/^\//, "");
  u.pathname = "/postgres";
  const sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select 1 from pg_database where datname = ${dbName}`;
    if (rows.length === 0) await sql.unsafe(`create database "${dbName}"`);
  } finally {
    await sql.end();
  }
}

export async function prepareTestDatabase(url: string): Promise<void> {
  await ensureDatabase(url);
  await runMigrations(url);
}

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = url;
  await prepareTestDatabase(url);
}
