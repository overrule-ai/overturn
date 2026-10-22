---
title: Data & security
description: What leaves your systems, how to keep secrets out, and how to run it yourself.
---

**Only what you send leaves your systems.** The SDK records model requests and responses and the tool calls you wrap. It does not read your environment, files or network. Pass `redact` to drop or edit any step before it is sent:

```ts
const ov = new Overturn({ redact: (step) => (step.name === "lookup_customer" ? { ...step, output: null } : step) });
```

**Keys.** API keys are shown once and stored hashed. Revoke from Settings; a revoked key stops working immediately. Browser code never needs a key: [CorrectButton](/docs/correct-button/) posts to your own server.

**Replay never executes side effects.** Tools declared `sideEffect: true` are refused during replay; the trajectory stops and the report says so. Nothing is re-sent, re-charged or re-written by a replay.

**Isolation.** Workspaces are separate rows in one Postgres; every query is scoped by project id and covered by tests. There is no cross-workspace access path in the API.

**Retention.** Per project, default 90 days for runs without a case. Runs behind a case are kept because they are the evidence.

**Hosted vs self-hosted.** The hosted service runs on Railway in the US. If your data cannot leave your network, run Overturn yourself: one Postgres with `pgvector`, two containers, documented in [Self-hosting](/docs/self-hosting/). The hosted and self-hosted builds are the same image.
