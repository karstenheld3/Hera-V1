// App directory resolution (HERAV1PRCF-SP01 FR-03, HERAV1PRCF-IP01 IS-03):
// --app-dir flag > env AGENT_APP_DIR > parent of process.execPath (compiled binary) > workspace (development).

import { dirname, isAbsolute, join, resolve } from "node:path";

export interface AppDirInputs {
  flag?: string | undefined;
  env?: string | undefined;
  cwd: string;
  standalone?: boolean;
  execPath?: string;
}

export function resolveAppDir(inputs: AppDirInputs): string {
  const standalone = inputs.standalone ?? Bun.isStandaloneExecutable;
  const execPath = inputs.execPath ?? process.execPath;
  const chosen = inputs.flag ?? inputs.env ?? (standalone ? dirname(execPath) : inputs.cwd);
  return isAbsolute(chosen) ? resolve(chosen) : resolve(inputs.cwd, chosen);
}

/** Relative `agent_folder` / `data_dir` values resolve against the app directory; absolute ones are used as-is. */
export function resolveUnderAppDir(appDir: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(appDir, value);
}

/** U12: path to the HMAC secret file for memory integrity. */
export function memorySecretPath(appDir: string): string {
  return join(appDir, "memory.secret");
}
