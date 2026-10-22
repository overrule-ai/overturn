---
title: Privacy
description: What the hosted Overturn stores, where, for how long, and how to delete it.
---

*Last updated 22 October 2026.*

**What we store.** Your email address (to sign you in and invite you to workspaces); API keys (hashed); the runs your SDK or exporter sends — prompts, model responses, tool calls and their results, run input and output, tags; corrections, with the actor name you supply; cases and replay results; project settings including any Slack webhook URL you configure. We store what you send: use the SDK's `redact` hook to drop or edit anything that should never leave your systems.

**Where.** Railway (US). Email is sent through Resend. Replays call the model providers you choose (OpenAI, Anthropic, Google, OpenRouter) with the prompts in your cases; those providers' terms apply to those calls.

**How long.** Runs that are not behind a case are deleted after the project's retention setting (default 90 days). Runs behind a case, and cases, corrections and replay results, are kept until you delete them. Sign-in links expire in 15 minutes; sessions in 30 days.

**Who can see it.** Members of your workspace. Maintainers can access the database to operate the service and will not look at your content except to debug a problem you report.

**Deleting.** Archive or delete cases and revoke keys in the app. To delete a whole workspace and everything in it, open a GitHub issue or email us from a workspace member's address; we delete within 7 days and confirm.

**Cookies.** One session cookie on app.overturn.run. No analytics, no third-party trackers.

**Self-hosting.** None of this applies when you run Overturn yourself: the data stays on your Postgres. See [Self-hosting](/docs/self-hosting/).

**Changes.** Posted here; material changes are emailed to workspace members.
