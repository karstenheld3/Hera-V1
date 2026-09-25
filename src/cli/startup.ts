// Startup sequence (HERAV1CLI-SP01 FR-04; HERAV1CLI-IP01 IS-06): app dir, config with all role sets (IG-04: validate every key before spawn),
// zero-setup artifacts, banner and notices. Every failure before the first spawn is a ConfigError (exit 2).

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { resolveAppDir } from "../config/appdir.ts";
import { keySourceLine, fileSourceWarning } from "../config/keys.ts";
import { loadConfig, rolesSummary, type ResolvedConfig } from "../config/load.ts";
import { ConfigError } from "../errors.ts";
import { loadWorkflowIndex } from "../prompt/loader.ts";
import { isScripted } from "../providers/registry.ts";
import { VERSION } from "../version.ts";
import { materialize } from "../bundled/index.ts";

export interface StartupResult {
  config: ResolvedConfig;
  appDir: string;
  workspace: string;
  scripted: boolean;
  /** banner and notice lines in print order */
  lines: string[];
  workflows: Array<{ name: string; description: string }>;
  resumePath: string | undefined;
}

export const RISK_STATEMENT = "Hera runs commands without asking; the Supervisor blocks denylisted and out-of-workspace destructive actions. Prompt-system content and tool results are untrusted input to the model.";

export function startup(args: ParsedArgs, env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): StartupResult {
  const appDir = resolveAppDir({ flag: args.appDir, env: env["AGENT_APP_DIR"], cwd });
  const scripted = isScripted(env);
  const mat = materialize(appDir);
  const config = loadConfig({ appDir, configPath: args.config ?? env["AGENT_CONFIG"], roles: "all", requireKeys: !scripted, scripted, env });
  const lines: string[] = [];
  for (const c of mat.created) lines.push(`Created '${c}'.`);
  for (const n of mat.notices) lines.push(n);
  for (const created of config.created) lines.push(`Created '${created}' with defaults.`);
  // zero-setup: data dir subfolders and the agent folder scaffold
  for (const sub of ["sessions", "memories", "logs"]) {
    const dir = join(config.dataDir, sub);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
        lines.push(`Created '${dir}'.`);
      } catch (error) {
        throw new ConfigError(`cannot create '${dir}': ${error instanceof Error ? error.message : String(error)}`, "Check the data_dir setting and the folder permissions.");
      }
    }
  }
  if (!existsSync(config.agentFolder)) {
    for (const sub of ["rules", "workflows", "skills"]) {
      const dir = join(config.agentFolder, sub);
      try {
        mkdirSync(dir, { recursive: true });
        lines.push(`Created '${dir}'.`);
      } catch (error) {
        throw new ConfigError(`cannot create '${dir}': ${error instanceof Error ? error.message : String(error)}`, "Check the agent_folder setting and the folder permissions.");
      }
    }
  }
  lines.push(`Hera ${VERSION}${scripted ? " [SCRIPTED]" : ""} | ${rolesSummary(config)}`);
  lines.push(scripted ? "Keys: not required (scripted adapter)" : keySourceLine(Object.values(config.keys)));
  if (!scripted) {
    const warn = fileSourceWarning(Object.values(config.keys));
    if (warn !== undefined) lines.push(warn);
  }
  for (const n of config.notices) if (!n.startsWith("Created ")) lines.push(n);
  const workflows = loadWorkflowIndex(config.agentFolder);
  lines.push(`Prompt system: '${config.agentFolder}' (${workflows.length} workflow${workflows.length === 1 ? "" : "s"} indexed; rules and skills load in the Executor)`);
  lines.push(RISK_STATEMENT);
  const profile = config.config.harness.profile;
  if (profile === "passthrough") {
    lines.push("WARNING: profile passthrough - no guards, no approvals");
  }
  if (args.approveAll) {
    lines.push("WARNING: --approve-all: every pending effect is approved");
  }
  const prevSession = latestSession(join(config.dataDir, "sessions"));
  if (prevSession !== undefined && existsSync(prevSession)) {
    try {
      const firstLine = readFileSync(prevSession, "utf8").split("\n")[0];
      if (firstLine) {
        const evt = JSON.parse(firstLine) as { type?: string; profile?: string; config_snapshot?: { harness?: { profile?: string } } };
        if (evt.type === "session_started") {
          const prevProfile = evt.profile || evt.config_snapshot?.harness?.profile || "";
          if (prevProfile && prevProfile !== profile) {
            lines.push(`NOTICE: profile changed from '${prevProfile}' to '${profile}' since the previous session.`);
          }
        }
      }
    } catch { /* ignore unreadable session files */ }
  }
  const resumePath = args.resume === undefined ? undefined : args.resume === true ? latestSession(join(config.dataDir, "sessions")) : args.resume;
  if (args.resume !== undefined && (resumePath === undefined || !existsSync(resumePath))) throw new ConfigError(`no session file to resume${typeof args.resume === "string" ? ` at '${args.resume}'` : ` in '${join(config.dataDir, "sessions")}'`}.`, "Run a session first or pass --resume <path>.");
  return { config, appDir, workspace: cwd, scripted, lines, workflows, resumePath };
}

export function latestSession(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const last = files[files.length - 1];
  return last === undefined ? undefined : join(dir, last);
}
