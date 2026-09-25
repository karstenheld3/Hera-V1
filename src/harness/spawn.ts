// Spawn boundary wrapper (HERAV1HRNS-SP01 FR-10, H-10; HERAV1HRNS-IP01 IS-20).
// One spawn() wrapper for every child process. Tool descendants get no provider credentials.
// Trusted Hera children keep the full environment. A profile may substitute a launcher
// (the host launcher is the only launcher in this implementation).

import { KEY_VARS } from "../config/keys.ts";

export type SpawnKind = "tool" | "trusted";

export interface SpawnOptions {
  /** Kind of spawn: "tool" strips provider credentials; "trusted" keeps the full environment. */
  kind: SpawnKind;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: "ignore" | "pipe";
  stdout?: "ignore" | "pipe";
  stderr?: "ignore" | "pipe" | "inherit";
  serialization?: "json";
  ipc?: (message: unknown, subprocess: BunSubprocess) => void;
  onExit?: (proc: BunSubprocess, exitCode: number | null, signalCode: string | null) => void;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
}

/** Provider credential variable names to strip from tool descendant environments. */
const PROVIDER_KEY_VARS: readonly string[] = Object.values(KEY_VARS);

/** Strips provider credential variables from the environment for tool descendants. */
function stripProviderCredentials(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const stripped = { ...env };
  for (const key of PROVIDER_KEY_VARS) delete stripped[key];
  return stripped;
}

/**
 * The single spawn() wrapper for every child process (FR-10).
 * Tool descendants ("tool" kind) receive an environment without provider credentials.
 * Trusted Hera children ("trusted" kind) keep the full environment.
 */
export function spawn(argv: string[], opts: SpawnOptions): BunSubprocess {
  const baseEnv: Record<string, string | undefined> = { ...process.env, ...opts.env };
  const env = opts.kind === "tool" ? stripProviderCredentials(baseEnv) : baseEnv;
  return Bun.spawn(argv, {
    cwd: opts.cwd,
    env,
    stdin: opts.stdin ?? "ignore",
    stdout: opts.stdout ?? "pipe",
    stderr: opts.stderr ?? "pipe",
    serialization: opts.serialization,
    ipc: opts.ipc,
    onExit: opts.onExit,
    windowsHide: opts.windowsHide,
    windowsVerbatimArguments: opts.windowsVerbatimArguments,
  });
}
