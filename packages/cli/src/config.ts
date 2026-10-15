/**
 * overturn.config.ts contract. Trajectory replay (M5) loads it, puts the SDK in
 * replay mode with a case's tool recordings, and calls `agent(input, ctx)`.
 */
export interface ReplayContext {
  caseId: string;
  runId: string;
  /** provider/model the replay targets; wrappers created through the SDK are swapped to it. */
  model: string;
  promptVersion?: string;
}

export interface OverturnConfig {
  /** Called once per case with the recorded run input; return the run's output. */
  agent: (input: unknown, ctx: ReplayContext) => Promise<unknown>;
  /** Stop a trajectory after this many steps. Default 50. */
  maxSteps?: number;
}

export function defineConfig(config: OverturnConfig): OverturnConfig {
  return config;
}
