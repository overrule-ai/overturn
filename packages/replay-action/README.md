# Overturn replay action

Replays your human-corrected cases against a model or prompt on every pull request, comments the report, and fails the check on regressions.

```yaml
name: Overturn replay
on:
  pull_request:
    paths: ["prompts/**", "src/agent/**"]
permissions:
  contents: read
  pull-requests: write
jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: overrule-ai/overturn/packages/replay-action@main
        with:
          api-key: ${{ secrets.OVERTURN_API_KEY }}
          model: openai/gpt-4.1-mini
          since: 30d
          fail-on-regression: 0
```

Inputs: `model` (required), `mode` (`step` | `trajectory`), `since`, `agent`, `tag`, `set`, `prompt` (`name@version`), `max-cost`, `fail-on-regression` (default 0), `comment`, `config`, `working-directory`, `cli-command`, `base-url`.

Trajectory mode runs your agent through `overturn.config.ts` in `working-directory`, so install your dependencies first.
