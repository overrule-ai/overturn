import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadDotEnv } from "../env";
import { createDb } from "./client";

export async function runMigrations(url: string): Promise<void> {
  const { db, sql } = createDb(url, { max: 1 });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  loadDotEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      console.log("migrations applied");
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
