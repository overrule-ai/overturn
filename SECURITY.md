# Security

Report vulnerabilities privately to shireen@overturn.run with steps to reproduce. You will get a reply within three business days and a fix or mitigation plan within fourteen.

Please do not open public issues for security problems, and give us a reasonable window before disclosing.

## Scope

- The hosted service at app.overturn.run / api.overturn.run
- This repository: the API, web app, SDKs, CLI, trainer and GitHub Action

## What we do on our side

- Secrets are never committed; see `.env.example`
- Recordings never leave your network when self-hosted; the hosted service stores only what the SDK sends
- API keys are hashed at rest and shown once
