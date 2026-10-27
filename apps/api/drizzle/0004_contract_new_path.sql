ALTER TYPE "verdict" ADD VALUE IF NOT EXISTS 'new_path' BEFORE 'error';--> statement-breakpoint
ALTER TYPE "case_status" ADD VALUE IF NOT EXISTS 'suppressed';--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "contract" jsonb DEFAULT '[]'::jsonb NOT NULL;
