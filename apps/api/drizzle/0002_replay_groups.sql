ALTER TABLE "replay_jobs" ADD COLUMN "group_id" uuid;
CREATE INDEX "replay_jobs_group" ON "replay_jobs" USING btree ("group_id");
