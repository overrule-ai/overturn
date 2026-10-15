import { AsyncLocalStorage } from "node:async_hooks";
import type { Run } from "./run.js";

export interface RunContext {
  run: Run;
  parentStepId: string | null;
}

// One AsyncLocalStorage per process, shared across copies of this package (the CLI bundles its own),
// so a run started by the trajectory runner is visible to the customer's agent code.
const KEY = Symbol.for("overturn.run.storage");
const g = globalThis as Record<symbol, unknown>;
function sharedStorage(): AsyncLocalStorage<RunContext> {
  const existing = g[KEY] as AsyncLocalStorage<RunContext> | undefined;
  if (existing) return existing;
  const created = new AsyncLocalStorage<RunContext>();
  g[KEY] = created;
  return created;
}
export const runStorage: AsyncLocalStorage<RunContext> = sharedStorage();

export function currentRun(): Run | undefined {
  return runStorage.getStore()?.run;
}

export function currentContext(): RunContext | undefined {
  return runStorage.getStore();
}
