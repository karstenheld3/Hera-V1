// Config fixture helpers (HERAV1PRCF-TP01 section 8): temp app directories with the shipped data files.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, makeTempDir } from "./procs.ts";

export type ConfigFixture = "v1_user_shape" | "v2_minimal" | "v2_mixed" | "v2_unknown_key" | "broken" | "v1_empty_denylist" | "none";

export const DATA_FILES = ["model-registry.json", "model-parameter-mapping.json", "model-pricing.json"] as const;

/** Creates `<tmp>/.agent-data/config/` with the three shipped data files and the chosen agent-config fixture (or none). */
export function tempAppDir(fixture: ConfigFixture, label = "cfg"): { appDir: string; configDir: string; configPath: string } {
  const appDir = makeTempDir(label);
  const configDir = join(appDir, ".agent-data", "config");
  mkdirSync(configDir, { recursive: true });
  for (const name of DATA_FILES) copyFileSync(join(REPO_ROOT, ".agent-data", "config", name), join(configDir, name));
  const configPath = join(configDir, "agent-config.json");
  if (fixture !== "none") copyFileSync(join(REPO_ROOT, "tests", "fixtures", "configs", `${fixture}.json`), configPath);
  return { appDir, configDir, configPath };
}

export function writeConfig(configPath: string, value: unknown): void {
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readBytes(path: string): string {
  return readFileSync(path, "utf8");
}

/** A clean environment object: only the overrides, never the developer's real variables. */
export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...overrides };
}
