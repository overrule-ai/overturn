import { ov } from "@/lib/overturn";

// <CorrectButton endpoint="/api/overturn/correct"> posts here. In a real app, resolve
// the actor from your session (NextAuth, Clerk, a cookie); the demo reads a header.
export const POST = ov.correctionHandler({
  actor: (req) => req.headers.get("x-reviewer") ?? "reviewer@example.com",
});
