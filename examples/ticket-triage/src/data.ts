import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

export interface Ticket {
  id: string;
  customerEmail: string;
  subject: string;
  body: string;
}
export interface Customer {
  email: string;
  name: string;
  company: string | null;
  plan: "enterprise" | "pro" | "free";
  seats: number;
}
export interface KbArticle {
  id: string;
  title: string;
  body: string;
  tags: string[];
}

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(dataDir, name), "utf8")) as T;
}

export const tickets: Ticket[] = load("tickets.json");
export const customers: Customer[] = load("customers.json");
export const kb: KbArticle[] = load("kb.json");

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const TEAMS = [
  "infrastructure",
  "identity",
  "billing",
  "integrations",
  "mobile",
  "trust",
  "support",
] as const;
export type Team = (typeof TEAMS)[number];

export interface Decision {
  priority: Priority;
  team: Team;
  reply: string;
}
