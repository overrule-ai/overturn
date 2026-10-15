import { AsyncLocalStorage } from "node:async_hooks";
import type { Run } from "./run.js";

export interface RunContext {
  run: Run;
  parentStepId: string | null;
}

export const runStorage = new AsyncLocalStorage<RunContext>();

export function currentRun(): Run | undefined {
  return runStorage.getStore()?.run;
}

export function currentContext(): RunContext | undefined {
  return runStorage.getStore();
}
