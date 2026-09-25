// Live-test gating (HERAV1AGNT-TP01 section 3): a provider key is "present" when its variable is set in the
// environment or a `VAR=<non-empty>` line exists in config/.api-keys.txt. Only presence is read - values never
// reach an assertion or a log.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { REPO_ROOT } from "./procs.ts";

export type LiveProvider = "openai" | "anthropic" | "zai";

export const KEY_VARS: Record<LiveProvider, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", zai: "ZAI_API_KEY" };

export function keyFilePath(): string {
  return process.env["HERA_TEST_KEY_FILE"] ?? join(REPO_ROOT, ".agent-data", "config", ".api-keys.txt");
}

export function hasKey(provider: LiveProvider, env: Record<string, string | undefined> = process.env, keyFile: string = keyFilePath()): boolean {
  const name = KEY_VARS[provider];
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return true;
  if (!existsSync(keyFile)) return false;
  const pattern = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*["']?[^"'\\s#]+`, "m");
  return pattern.test(readFileSync(keyFile, "utf8"));
}

let spentUsd = 0;
export const LIVE_BUDGET_USD = Number(process.env["HERA_LIVE_BUDGET_USD"] ?? "1");

export function recordSpend(usd: number): void {
  spentUsd += usd;
  if (spentUsd > LIVE_BUDGET_USD) throw new Error(`live budget exceeded: ${spentUsd.toFixed(4)} USD > ${LIVE_BUDGET_USD} USD`);
}

export function spentSoFar(): number {
  return spentUsd;
}

/** Registers a live test that is skipped (not failed) when the provider key is absent. */
export function liveTest(name: string, provider: LiveProvider, fn: () => Promise<void>, timeoutMs = 60000): void {
  test.skipIf(!hasKey(provider))(`[live] ${name}`, fn, timeoutMs);
}
