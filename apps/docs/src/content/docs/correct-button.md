---
title: Corrections from your UI
description: Drop <CorrectButton> into your product; the key stays on your server.
---

The best corrections come from the people already reviewing the agent's work, inside the product they already use. `<CorrectButton>` is a React component that posts to a route on *your* server; your server calls Overturn with the project key, so the key never reaches the browser and the actor comes from your own session.

## Server route

```ts
// app/api/overturn/correct/route.ts (Next.js; any Request/Response runtime works)
import { Overturn } from "@overturn-ai/sdk";
const ov = new Overturn();
export const POST = ov.correctionHandler({
  actor: async (req) => (await getSession(req))?.email ?? null,
});
```

Return a `Response` from `actor` to refuse (for example a 401). The handler validates the body, calls `ov.correct()` and returns the correction and the new case.

Python (FastAPI / Flask):

```python
@app.post("/api/overturn/correct")
def correct(body: dict, user=Depends(current_user)):
    return ov.handle_correction(body, actor=user.email)   # raises CorrectionRequestError -> 400
```

## Component

```tsx
import { CorrectButton } from "@overturn-ai/sdk/react";

<CorrectButton
  endpoint="/api/overturn/correct"
  runId={run.id}            // the run your agent recorded (ov.startRun(...).id)
  original={run.output}     // prefilled when the reviewer picks Edit
  onDone={refresh}
/>
```

It opens Approve / Edit / Reject / Escalate with a note, posts, and shows "Correction recorded". Props: `stepId` to correct one model step instead of the final answer, `kinds` to narrow the choices, `headers` for a CSRF token, `className`/`style` to restyle. React ≥ 18, no other dependencies.
