// Role dispatch helpers and self-spawn (HERAV1PROC-IP01 IS-03; spawn shapes from poc/ipc/poc.ts [TESTED]).
// U12: self-spawn goes through the spawn wrapper (HERAV1HRNS-SP01 FR-10) with the host launcher and the full environment.

import { fileURLToPath } from "node:url";
import type { ChildRole } from "../models.ts";
import { spawn as harnessSpawn } from "../harness/spawn.ts";

/** The package entry resolved from this module - never `Bun.main`, which is the CALLER's script under `bun run` (HERAV1-FL-0002). */
export const PACKAGE_ENTRY: string = fileURLToPath(new URL("../index.ts", import.meta.url));

/** `[execPath, "--role", role, "--epoch", n]` in the binary; `[execPath, <package entry>, ...]` under `bun run` (FR-01, DD-04). */
export function spawnCommand(role: ChildRole, epoch: number, standalone: boolean = Bun.isStandaloneExecutable, execPath: string = process.execPath, main: string = PACKAGE_ENTRY): string[] {
  const head = standalone ? [execPath] : [execPath, main];
  return [...head, "--role", role, "--epoch", String(epoch)];
}

export interface SpawnChildOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  onMessage(message: unknown, subprocess: BunSubprocess): void;
  onExit(exitCode: number | null, signalCode: string | null): void;
  /** debug line routing (HERAV1DEBG-SP01 FR-01): set → inherited by the child, undefined → cleared */
  debugLines?: string;
  stdout?: "ignore" | "pipe";
  /** development-mode entry script (default: the package entry `src/index.ts`; stub roles in tests pass their own script) */
  main?: string;
}

/** Spawns one child role with the DD-05 stdio contract: stdin ignore, stdout ignore, stderr inherit, ipc json. */
export function spawnChild(role: ChildRole, epoch: number, opts: SpawnChildOptions): BunSubprocess {
  const env: Record<string, string | undefined> = { ...opts.env };
  if (opts.debugLines !== undefined) env["HERA_DEBUG_LINES"] = opts.debugLines;
  else delete env["HERA_DEBUG_LINES"];
  return harnessSpawn(spawnCommand(role, epoch, Bun.isStandaloneExecutable, process.execPath, opts.main ?? PACKAGE_ENTRY), {
    kind: "trusted",
    cwd: opts.cwd,
    env,
    stdin: "ignore",
    stdout: opts.stdout ?? "ignore",
    stderr: "inherit",
    serialization: "json",
    ipc: opts.onMessage,
    onExit: (_proc, exitCode, signalCode) => opts.onExit(exitCode, signalCode),
  });
}

/** True when this process was spawned with an IPC channel (EC-14). */
export function hasIpcChannel(): boolean {
  return typeof process.send === "function";
}
