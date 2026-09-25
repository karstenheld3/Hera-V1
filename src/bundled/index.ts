// Embedded payload and zero-setup materialization (HERAV1DIST-SP01 FR-08; HERAV1DIST-IP01 IS-01).
// Config JSON files and rg.exe are embedded via `with { type: "file" }` imports; the agent library
// is embedded via `--asset src/bundled/agent` in the compile command. Under `bun run` the imports
// resolve to workspace paths (after `build.ps1 -SyncOnly`); under the compiled binary they resolve
// to the virtual filesystem.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../errors.ts";
import { KEY_FILE_TEMPLATE } from "../config/keys.ts";
import { defaultConfigText } from "../config/schema.ts";
import { BINARY_VERSION } from "../version.ts";

import registryPath from "./config/model-registry.json" with { type: "file" };
import mappingPath from "./config/model-parameter-mapping.json" with { type: "file" };
import pricingPath from "./config/model-pricing.json" with { type: "file" };
import rgPath from "./tools/rg.exe" with { type: "file" };

export const AGENT_DIR = join(import.meta.dir, "agent");
export { BINARY_VERSION };

export interface MaterializeReport {
  created: string[];
  notices: string[];
}

function writeFileSafe(dst: string, data: string | Buffer, created: string[]): void {
  try {
    writeFileSync(dst, data);
    created.push(dst);
  } catch (error) {
    throw new ConfigError(
      `cannot create '${dst}': ${error instanceof Error ? error.message : String(error)}`,
      "Check the folder permissions or use --app-dir.",
    );
  }
}

function mkdirSafe(dst: string, created: string[]): void {
  try {
    mkdirSync(dst, { recursive: true });
    created.push(dst);
  } catch (error) {
    throw new ConfigError(
      `cannot create '${dst}': ${error instanceof Error ? error.message : String(error)}`,
      "Check the folder permissions or use --app-dir.",
    );
  }
}

function copyTree(src: string, dst: string): number {
  let count = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dstPath, { recursive: true });
      count += copyTree(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
      count++;
    }
  }
  return count;
}

/**
 * Materializes the default payload into the app directory on first run (FR-08).
 * Existing files are NEVER overwritten. Returns the list of created paths and notices.
 */
export function materialize(appDir: string): MaterializeReport {
  const created: string[] = [];
  const notices: string[] = [];
  const configDir = join(appDir, ".agent-data", "config");

  // Config JSON files (from embedded file paths)
  const configFiles: Array<[string, string]> = [
    [registryPath as unknown as string, "model-registry.json"],
    [mappingPath as unknown as string, "model-parameter-mapping.json"],
    [pricingPath as unknown as string, "model-pricing.json"],
  ];
  if (!existsSync(configDir)) mkdirSafe(configDir, created);
  for (const [srcPath, name] of configFiles) {
    const dst = join(configDir, name);
    if (!existsSync(dst)) {
      writeFileSafe(dst, readFileSync(srcPath, "utf8"), created);
    }
  }

  // Key file template (keyless, from code constant)
  const keyFile = join(configDir, ".api-keys.txt");
  if (!existsSync(keyFile)) {
    writeFileSafe(keyFile, KEY_FILE_TEMPLATE, created);
  }

  // Default agent-config.json (only when missing; existing V1-shaped file is migrated in memory by loadConfig)
  const configFile = join(configDir, "agent-config.json");
  if (!existsSync(configFile)) {
    writeFileSafe(configFile, defaultConfigText(), created);
  }

  // Agent folder (prompt library) - only when the folder does not exist at all
  const agentDir = join(appDir, ".agent");
  if (!existsSync(agentDir)) {
    if (existsSync(AGENT_DIR)) {
      const count = copyTree(AGENT_DIR, agentDir);
      if (count > 0) created.push(`${agentDir} (${count} files)`);
    } else {
      mkdirSafe(agentDir, created);
      for (const sub of ["rules", "workflows", "skills"]) {
        mkdirSync(join(agentDir, sub), { recursive: true });
      }
    }
  }

  // rg.exe (embedded as-is, no .bin rename)
  const toolsDir = join(appDir, ".agent-tools");
  const rgDst = join(toolsDir, "rg.exe");
  const rgSrc = rgPath as unknown as string;
  if (!existsSync(rgDst)) {
    mkdirSync(toolsDir, { recursive: true });
    writeFileSafe(rgDst, readFileSync(rgSrc), created);
  } else {
    // Content hash mismatch: a differing helper executable is rejected (FR-05)
    try {
      const embeddedData = readFileSync(rgSrc);
      const existingData = readFileSync(rgDst);
      const embeddedHash = new Bun.CryptoHasher("sha256").update(embeddedData).digest("hex");
      const existingHash = new Bun.CryptoHasher("sha256").update(existingData).digest("hex");
      if (embeddedHash !== existingHash) {
        throw new ConfigError(
          `'${rgDst}' content hash differs from the embedded rg.exe (embedded ${embeddedHash.slice(0, 16)}, existing ${existingHash.slice(0, 16)}) - remove the existing file or use --app-dir.`,
          "Delete the existing rg.exe so materialize can replace it, or point --app-dir at a fresh directory.",
        );
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      // stat/read failure is non-fatal
    }
  }

  // Data dir subfolders
  const dataDir = join(appDir, ".agent-data");
  for (const sub of ["sessions", "memories", "logs"]) {
    const dir = join(dataDir, sub);
    if (!existsSync(dir)) {
      mkdirSafe(dir, created);
    }
  }

  return { created, notices };
}
