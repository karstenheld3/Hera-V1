// Process and timing helpers shared by the integration tests (HERAV1PROC-TP01 section 8).

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const TMP_ROOT = join(REPO_ROOT, "tests", ".tmp");
export const ENTRY = join(REPO_ROOT, "src", "index.ts");

/** Command prefix for the product under test: the compiled binary when HERA_TEST_BINARY is set, else `bun run src/index.ts`. */
export function heraCommand(): string[] {
  const binary = process.env["HERA_TEST_BINARY"];
  if (binary !== undefined && binary.length > 0) return [binary];
  return [process.execPath, "run", ENTRY];
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const started = performance.now();
  while (!pred()) {
    if (performance.now() - started > timeoutMs) throw new Error(`timeout after ${timeoutMs} ms waiting for ${what}`);
    await Bun.sleep(5);
  }
}

export async function waitForValue<T>(get: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  let value: T | undefined;
  await waitFor(() => {
    value = get();
    return value !== undefined;
  }, timeoutMs, what);
  return value as T;
}

let tmpCounter = 0;

/** Temp folder under tests/.tmp (a real drive path, never %TEMP%) - removed by the caller in afterEach. */
export function makeTempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = join(TMP_ROOT, `${label}_${process.pid}_${Date.now()}_${tmpCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Windows: a handle may still be closing; retry briefly
      const until = Date.now() + 100;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

export function killQuiet(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
