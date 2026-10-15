/**
 * Trajectory replay (M5): loads overturn.config.ts, puts the SDK in replay mode with each
 * case's tool recordings, calls agent(input) and posts the results. Implemented in M5;
 * this module only reserves the interface so `overturn replay --mode trajectory` is routed.
 */
import type { OverturnApi, ReplayJob } from "@overturn/sdk";

export interface TrajectoryOptions {
  api: OverturnApi;
  model: string;
  filter: Record<string, unknown>;
  maxCostUsd?: number;
  promptVersion?: string;
  log: (message: string) => void;
}

export async function runTrajectory(_opts: TrajectoryOptions): Promise<ReplayJob> {
  throw new Error("trajectory mode lands in milestone 5 (days 10–11); use --mode step for now");
}
