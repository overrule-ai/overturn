CREATE TABLE "trained_models" (
  "id" uuid PRIMARY KEY NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "provider" text DEFAULT 'together' NOT NULL,
  "base_model" text NOT NULL,
  "method" text DEFAULT 'sft' NOT NULL,
  "epochs" integer DEFAULT 1 NOT NULL,
  "case_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dataset_stats" jsonb,
  "status" text DEFAULT 'exporting' NOT NULL,
  "error" text,
  "provider_file_id" text,
  "provider_job_id" text,
  "output_name" text,
  "served_as" text,
  "training_cost_usd" double precision,
  "gate_job_id" uuid,
  "gate" jsonb,
  "shadow" boolean DEFAULT false NOT NULL,
  "shadow_since" timestamp with time zone,
  "promoted_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "trained_models_project" ON "trained_models" ("project_id","created_at");--> statement-breakpoint
CREATE TABLE "shadow_results" (
  "id" uuid PRIMARY KEY NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "model_id" uuid NOT NULL REFERENCES "trained_models"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "output" jsonb,
  "error" text,
  "latency_ms" double precision,
  "cost_usd" double precision,
  "agrees_with_production" boolean,
  "passed" boolean,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_results_model_run" ON "shadow_results" ("model_id","run_id");--> statement-breakpoint
CREATE INDEX "shadow_results_run" ON "shadow_results" ("run_id");
