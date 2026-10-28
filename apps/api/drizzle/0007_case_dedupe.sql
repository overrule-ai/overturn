ALTER TABLE "cases" ADD COLUMN "input_hash" text;
ALTER TABLE "cases" ADD COLUMN "duplicates" integer DEFAULT 0 NOT NULL;
ALTER TABLE "cases" ADD COLUMN "last_seen_at" timestamp with time zone;
CREATE INDEX "cases_project_hash" ON "cases" ("project_id", "input_hash");
