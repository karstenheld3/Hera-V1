// LocalGuards plug - Hera's desktop rider behind the gate socket (HERAV1HRNS-SP01 DD-05, FR-01).
// Ports src/supervisor/guards.ts denylist, shell wrapper, and workspace boundary rules
// as a GateProvider. Returns allow, block, or pending (run_command approval policy); never unavailable.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EffectDescriptor } from "../descriptor.ts";
import type { AdmitResult, GateAnswer, GateProvider } from "../provider.ts";
import { scanKeyShapes } from "./keyshapes.ts";

export const SHELL_WRAPPERS: readonly string[] = ["pwsh", "powershell", "cmd", "bash"];
export const WRAPPER_EXECUTION_FLAGS: readonly string[] = ["-command", "-c", "/c"];
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "multi_edit", "write_to_file"]);
export const READ_TOOLS: ReadonlySet<string> = new Set(["read_file", "list_dir", "search"]);

const PATH_PARAMETERS: Readonly<Record<string, string>> = {
  read_file: "file_path",
  list_dir: "DirectoryPath",
  search: "SearchPath",
  edit: "file_path",
  multi_edit: "file_path",
  write_to_file: "TargetFile",
};

export type GuardRule = "denylist" | "shell_wrapper" | "workspace_boundary";

export const DEFAULT_NETWORK_COMMANDS: readonly string[] = Object.freeze([
  "curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "ftp", "telnet",
  "bitsadmin", "certutil", "Invoke-WebRequest", "iwr", "Invoke-RestMethod", "irm", "Start-BitsTransfer",
]);

export type ApprovalMode = "unsafe" | "all" | "off";

export interface LocalGuardsConfig {
  denylist: readonly string[];
  workspace: string;
  read_allowlist?: readonly string[];
  protected_paths?: readonly string[];
  network_commands?: readonly string[];
  approval?: ApprovalMode;
}

/** Splits a command line into tokens honoring double and single quotes (non-POSIX: backslashes are literal). */
export function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let inToken = false;
  for (const ch of commandLine) {
    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/** First whitespace-delimited token: quotes stripped, path stripped, `.exe` removed, case-folded. */
export function normalizeFirstToken(commandLine: string): string {
  const stripped = commandLine.trim();
  if (stripped.length === 0) return "";
  const tokens = tokenize(stripped);
  let token = tokens[0] ?? "";
  token = token.replace(/^["']+|["']+$/g, "");
  token = token.replace(/\\/g, "/");
  const slash = token.lastIndexOf("/");
  if (slash >= 0) token = token.slice(slash + 1);
  if (token.toLowerCase().endsWith(".exe")) token = token.slice(0, -4);
  return token.toLowerCase();
}

/** Single-token entries match the first token; multi-token entries prefix-match the command line (case-insensitive). */
export function matchDenylist(commandLine: string, entries: readonly string[]): string | undefined {
  const token = normalizeFirstToken(commandLine);
  const lowered = commandLine.trim().toLowerCase();
  for (const entry of entries) {
    const folded = entry.trim().toLowerCase();
    if (folded.length === 0) continue;
    if (folded.includes(" ")) {
      if (lowered.startsWith(folded)) return entry;
    } else if (token === folded) return entry;
  }
  return undefined;
}

export function isShellWrapper(commandLine: string): boolean {
  if (!SHELL_WRAPPERS.includes(normalizeFirstToken(commandLine))) return false;
  const lowered = ` ${commandLine.toLowerCase().trim()} `;
  return WRAPPER_EXECUTION_FLAGS.some((flag) => lowered.includes(` ${flag} `) || lowered.endsWith(` ${flag} `));
}

/** realpath of the deepest existing ancestor plus the remainder (the target may not exist yet). */
export function resolveRealPath(target: string, workspace: string): string {
  const absolute = isAbsolute(target) ? resolve(target) : resolve(workspace, target);
  let existing = absolute;
  const remainder: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    remainder.unshift(existing.slice(parent.length).replace(/^[\\/]/, ""));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    real = existing;
  }
  return remainder.length > 0 ? join(real, ...remainder) : real;
}

export function insideWorkspace(realPath: string, workspaceReal: string): boolean {
  const caseFold = process.platform === "win32";
  const a = caseFold ? realPath.toLowerCase() : realPath;
  const b = caseFold ? workspaceReal.toLowerCase() : workspaceReal;
  const rel = relative(b, a);
  return rel.length === 0 || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function toolPath(descriptor: EffectDescriptor): string | undefined {
  const paramName = PATH_PARAMETERS[descriptor.target];
  if (paramName === undefined) return undefined;
  const v = descriptor.parameters[paramName];
  return typeof v === "string" ? v : undefined;
}

/** Expand `~` to the user home directory and normalize path separators. */
function expandTilde(p: string): string {
  if (p === "~") return process.env["HOME"] ?? process.env["USERPROFILE"] ?? p;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const home = process.env["HOME"] ?? process.env["USERPROFILE"];
    return home !== undefined ? join(home, p.slice(2)) : p;
  }
  return p;
}

/** Case-fold on win32 for case-insensitive matching. */
function caseFold(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** Glob-match a resolved real path against protected path patterns. Returns the matching pattern or undefined. */
export function isProtected(realPath: string, protectedPaths: readonly string[]): string | undefined {
  const folded = caseFold(realPath).replace(/\\/g, "/");
  for (const pattern of protectedPaths) {
    const expanded = expandTilde(pattern);
    let foldedPattern = caseFold(expanded).replace(/\\/g, "/");
    const hasGlob = /[*?]/.test(foldedPattern);
    const hasSep = /[\\/]/.test(foldedPattern);
    if (!hasGlob) {
      if (!hasSep) {
        // Bare filename -> match as **/<filename>
        foldedPattern = `**/${foldedPattern}`;
      } else {
        // Path without glob -> match exact path or everything under it
        if (new Bun.Glob(foldedPattern).match(folded)) return pattern;
        foldedPattern = `${foldedPattern}/**`;
      }
    }
    const glob = new Bun.Glob(foldedPattern);
    if (glob.match(folded)) return pattern;
  }
  return undefined;
}

/** Check if a resolved real path matches any entry in the read allowlist. */
export function matchAllowlist(realPath: string, allowlist: readonly string[], workspace: string): boolean {
  const folded = caseFold(realPath);
  const workspaceFolded = caseFold(workspace);
  for (const entry of allowlist) {
    const expanded = expandTilde(entry);
    const resolved = isAbsolute(expanded) ? expanded : resolve(workspaceFolded, expanded);
    const foldedEntry = caseFold(resolveRealPath(resolved, workspace));
    if (folded === foldedEntry) return true;
    const glob = new Bun.Glob(foldedEntry);
    if (glob.match(folded)) return true;
  }
  return false;
}

export class LocalGuardsPlug implements GateProvider {
  private readonly storedDecisions = new Map<string, "allow" | "deny">();

  constructor(private readonly config: LocalGuardsConfig) {}

  admit(_definition_hash: string, _plug_hash: string, _interface_version: number): AdmitResult {
    return { admitted: true, run_ctx: crypto.getRandomValues(new Uint8Array(16)) };
  }

  request(descriptor: EffectDescriptor): GateAnswer {
    // Check stored decision first (re-request after resolve)
    const stored = this.storedDecisions.get(descriptor.effect_id);
    if (stored !== undefined) {
      this.storedDecisions.delete(descriptor.effect_id);
      return stored === "allow" ? "allow" : { answer: "block", reason: `denied by user` };
    }

    if (descriptor.target === "run_command") {
      const commandLine = typeof descriptor.parameters["CommandLine"] === "string" ? descriptor.parameters["CommandLine"] : "";
      const entry = matchDenylist(commandLine, this.config.denylist);
      if (entry !== undefined) return { answer: "block", reason: `blocked by denylist: entry '${entry}' matched '${normalizeFirstToken(commandLine)}'` };
      if (isShellWrapper(commandLine)) return { answer: "block", reason: `blocked by shell wrapper: '${normalizeFirstToken(commandLine)}' with an inline command is opaque to the guards` };
      if (scanKeyShapes(commandLine)) return { answer: "block", reason: "blocked by key shape: command line contains a key-shaped token" };

      // Approval policy (FR-05): pending when conditions met
      const approval = this.config.approval ?? "unsafe";
      if (approval === "off") return "allow";

      const safeToAutoRun = descriptor.parameters["SafeToAutoRun"] === true;
      const firstToken = normalizeFirstToken(commandLine);
      const networkCommands = this.config.network_commands ?? DEFAULT_NETWORK_COMMANDS;
      const isNetworkCommand = networkCommands.some((cmd) => cmd.toLowerCase() === firstToken);

      const cwd = typeof descriptor.parameters["Cwd"] === "string" ? descriptor.parameters["Cwd"] : undefined;
      const cwdOutsideWorkspace = cwd !== undefined && !insideWorkspace(resolveRealPath(cwd, this.config.workspace), resolveRealPath(this.config.workspace, this.config.workspace));

      if (approval === "all") return "pending";
      // approval === "unsafe"
      if (!safeToAutoRun) return "pending";
      if (isNetworkCommand) return "pending";
      if (cwdOutsideWorkspace) return "pending";

      return "allow";
    }
    const target = toolPath(descriptor);
    if (target === undefined) {
      if (descriptor.target === "read_url_content") {
        const url = typeof descriptor.parameters["Url"] === "string" ? descriptor.parameters["Url"] : "";
        if (scanKeyShapes(url)) return { answer: "block", reason: "blocked by key shape: URL contains a key-shaped token" };
      } else if (descriptor.target === "search_web") {
        const query = typeof descriptor.parameters["query"] === "string" ? descriptor.parameters["query"] : "";
        if (scanKeyShapes(query)) return { answer: "block", reason: "blocked by key shape: query contains a key-shaped token" };
      }
      return "allow";
    }
    const expandedTarget = expandTilde(target);
    const real = resolveRealPath(expandedTarget, this.config.workspace);
    const workspaceReal = resolveRealPath(this.config.workspace, this.config.workspace);

    // Protected paths: deny for both read and write, even inside workspace or allowlist (checked first)
    const protectedPaths = this.config.protected_paths ?? [];
    if (protectedPaths.length > 0) {
      const hit = isProtected(real, protectedPaths);
      if (hit !== undefined) return { answer: "block", reason: `blocked by protected paths: '${target}' matches '${hit}'` };
    }

    const isWrite = WRITE_TOOLS.has(descriptor.target);
    const isRead = READ_TOOLS.has(descriptor.target);

    if (isWrite || isRead) {
      if (!insideWorkspace(real, workspaceReal)) {
        if (isRead) {
          const allowlist = this.config.read_allowlist ?? [];
          if (allowlist.length > 0 && matchAllowlist(real, allowlist, this.config.workspace)) {
            return "allow";
          }
        }
        return { answer: "block", reason: `blocked by workspace boundary: '${target}' resolves outside the workspace '${workspaceReal}'` };
      }
    }
    return "allow";
  }

  resolve(effect_id: string, decision?: "allow" | "deny"): void {
    if (decision !== undefined) {
      this.storedDecisions.set(effect_id, decision);
    }
  }

  halt(_reason: string): void {}
}
