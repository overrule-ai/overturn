import { Overturn } from "@overturn-ai/sdk";

// One client for the whole server: reads OVERTURN_API_KEY / OVERTURN_BASE_URL.
// The key never reaches the browser; the page and the route handler both use this.
export const ov = new Overturn();
