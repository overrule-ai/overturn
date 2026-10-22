# next-review

A Next.js page that lists your agent's runs and puts `<CorrectButton>` next to each answer. The Overturn key stays on the server: the button posts to `app/api/overturn/correct/route.ts`, which is `ov.correctionHandler()`.

```bash
OVERTURN_API_KEY=ov_live_… OVERTURN_BASE_URL=https://api.overturn.run pnpm --filter @overturn-ai/example-next-review dev
# http://localhost:3100
```

Files that matter: `lib/overturn.ts` (one client), `app/api/overturn/correct/route.ts` (the handler; swap the header for your session), `app/review.tsx` (the button).
