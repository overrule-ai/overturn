import { type FingerprintOptions, toolFingerprint } from "@overturn-ai/shared";
import { currentRun } from "./context.js";
import type { ReplayState } from "./replay.js";

export interface ToolOptions extends FingerprintOptions {
  /** Does this tool change the world (send, write, close)? Refused outright in replay. Default false. */
  sideEffect?: boolean;
  description?: string;
}

export type ToolImpl<A, R> = (args: A) => Promise<R> | R;

export interface WrappedTool<A, R> {
  (args: A): Promise<R>;
  readonly toolName: string;
  readonly options: ToolOptions;
  readonly impl: ToolImpl<A, R>;
  fingerprint(args: A): string;
}

export interface ToolHost {
  replay: ReplayState | null;
}

export function makeTool<A, R>(
  host: ToolHost,
  name: string,
  impl: ToolImpl<A, R>,
  options: ToolOptions = {},
): WrappedTool<A, R> {
  const fp = (args: A): string => toolFingerprint(name, args, options);

  const wrapped = async (args: A): Promise<R> => {
    const run = currentRun();
    const fingerprint = fp(args);
    const startedAt = new Date();

    if (host.replay) {
      const output = host.replay.answer(name, args, fingerprint, options.sideEffect ?? false);
      run?.step({
        kind: "tool_call",
        name,
        input: args,
        output,
        sideEffect: options.sideEffect ?? false,
        fingerprint,
        latencyMs: 0,
        startedAt,
      });
      return output as R;
    }

    try {
      const output = await impl(args);
      run?.step({
        kind: "tool_call",
        name,
        input: args,
        output,
        sideEffect: options.sideEffect ?? false,
        fingerprint,
        latencyMs: Date.now() - startedAt.getTime(),
        startedAt,
      });
      return output;
    } catch (err) {
      run?.step({
        kind: "tool_call",
        name,
        input: args,
        error: err instanceof Error ? err.message : String(err),
        sideEffect: options.sideEffect ?? false,
        fingerprint,
        latencyMs: Date.now() - startedAt.getTime(),
        startedAt,
      });
      throw err;
    }
  };

  return Object.assign(wrapped, { toolName: name, options, impl, fingerprint: fp }) as WrappedTool<A, R>;
}
