import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;
}

export function short(v: unknown, max = 80): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
