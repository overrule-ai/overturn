CREATE TYPE "public"."case_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."correction_kind" AS ENUM('approve', 'edit', 'reject', 'escalate');--> statement-breakpoint
CREATE TYPE "public"."correction_source" AS ENUM('sdk', 'ui', 'api', 'implicit');--> statement-breakpoint
CREATE TYPE "public"."replay_mode" AS ENUM('step', 'trajectory');--> statement-breakpoint
CREATE TYPE "public"."replay_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."step_kind" AS ENUM('llm_call', 'tool_call', 'retrieval', 'human');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('pass', 'fail', 'regression', 'fixed', 'unchanged', 'unreplayable', 'error');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "case_sets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"correction_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"agent" text NOT NULL,
	"agent_version" text,
	"kind" "correction_kind" NOT NULL,
	"title" text NOT NULL,
	"frozen_input" jsonb NOT NULL,
	"tool_recordings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"original_output" jsonb,
	"expected" jsonb,
	"scorer" text NOT NULL,
	"scorer_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "case_status" DEFAULT 'active' NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"recorded_model" text,
	"last_verdict" "verdict",
	"expected_embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"kind" "correction_kind" NOT NULL,
	"corrected_output" jsonb,
	"note" text,
	"actor" text,
	"source" "correction_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"template" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"target_model" text NOT NULL,
	"target_prompt_version" text,
	"mode" "replay_mode" DEFAULT 'step' NOT NULL,
	"case_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "replay_status" DEFAULT 'pending' NOT NULL,
	"summary" jsonb,
	"estimated_cost_usd" double precision,
	"max_cost_usd" double precision,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"case_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"output" jsonb,
	"score" double precision,
	"passed" boolean,
	"verdict" "verdict" NOT NULL,
	"reason" text,
	"latency_ms" double precision,
	"cost_usd" double precision,
	"diff" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "response_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"output" jsonb NOT NULL,
	"usage" jsonb,
	"cost_usd" double precision,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"external_id" text,
	"agent" text NOT NULL,
	"agent_version" text,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"metadata" jsonb,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"step_count" integer DEFAULT 0 NOT NULL,
	"correction_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"parent_step_id" uuid,
	"seq" integer NOT NULL,
	"kind" "step_kind" NOT NULL,
	"name" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"model" text,
	"provider" text,
	"params" jsonb,
	"usage" jsonb,
	"cost_usd" double precision,
	"latency_ms" double precision,
	"error" text,
	"side_effect" boolean DEFAULT false NOT NULL,
	"fingerprint" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_sets" ADD CONSTRAINT "case_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_correction_id_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."corrections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_jobs" ADD CONSTRAINT "replay_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_results" ADD CONSTRAINT "replay_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_results" ADD CONSTRAINT "replay_results_job_id_replay_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."replay_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_results" ADD CONSTRAINT "replay_results_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_project" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "cases_project_created" ON "cases" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "cases_project_agent" ON "cases" USING btree ("project_id","agent");--> statement-breakpoint
CREATE INDEX "cases_tags" ON "cases" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "cases_correction" ON "cases" USING btree ("correction_id");--> statement-breakpoint
CREATE INDEX "corrections_run" ON "corrections" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "corrections_project_created" ON "corrections" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug" ON "projects" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_name_version" ON "prompt_versions" USING btree ("project_id","name","version");--> statement-breakpoint
CREATE INDEX "replay_jobs_project_created" ON "replay_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_results_job_case" ON "replay_results" USING btree ("job_id","case_id");--> statement-breakpoint
CREATE INDEX "replay_results_case" ON "replay_results" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "response_cache_expires" ON "response_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "runs_project_started" ON "runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "runs_project_agent" ON "runs" USING btree ("project_id","agent");--> statement-breakpoint
CREATE INDEX "runs_tags" ON "runs" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "steps_run_seq" ON "steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "steps_fingerprint" ON "steps" USING btree ("project_id","fingerprint");