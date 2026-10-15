/** Runtime config for the browser: the API URL is read from the server's environment at request time, not at build time. */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const apiUrl = process.env.OVERTURN_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  return Response.json({ apiUrl: apiUrl.replace(/\/+$/, "") }, { headers: { "cache-control": "no-store" } });
}
