ALTER TABLE "cases" ADD COLUMN "input_text" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "input_embedding" vector;--> statement-breakpoint
ALTER TABLE "replay_jobs" ADD COLUMN "options" jsonb DEFAULT '{}'::jsonb NOT NULL;
