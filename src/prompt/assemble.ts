// System prompt assembly in the fixed FR-05 order (HERAV1PRCF-IP01 IS-07). Pure function of its inputs:
// the workspace tree is computed once at session start by workspaceTree() and passed in, so two calls with the
// same inputs are byte-identical (IG-01, EC-15). No date and no per-turn state enter the prompt.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXCLUDED_DIRECTORIES as TOOL_EXCLUDED_DIRECTORIES } from "../tools/definitions.ts";
import { injectedRules, type PromptSystem } from "./loader.ts";
import { CLOSING_LINE, DOMAIN_CLAUSES, IDENTITY, MEMORY_SYSTEM, PRINCIPLES, REPLY_FORMAT, TOOLS_AND_COMMANDS, UNTRUSTED_CONTENT, USER_RULES_PREAMBLE, capabilityNotice } from "./sections.ts";

/** One exclude list for the tree AND the search tool (HERAV1PRCF-SP01 DD-09, HERAV1-IN01 DR-07) - defined in tools/definitions.ts. */
export const EXCLUDED_DIRECTORIES: readonly string[] = TOOL_EXCLUDED_DIRECTORIES;

export interface WorkspaceInfo {
  os: string;
  workspace: string;
  gitRoot: string | undefined;
  /** pre-computed by workspaceTree(); undefined → "No workspace path available." */
  tree: string[] | undefined;
}

export const SECTION_ORDER = [
  "identity",
  "principles",
  "tools_and_commands",
  "domain_clauses",
  "reply_format",
  "workflows",
  "user_rules",
  "capability_notice",
  "user_information",
  "workspace_information",
  "memory_system",
  "untrusted_content_instructions",
] as const;

export function buildWorkflowsSection(system: PromptSystem): string {
  const lines = [
    "<workflows>",
    "Workflows are step lists invoked as /name. When a workflow is relevant or the user uses a slash command, the full workflow content arrives in the user message. Current workflows:",
  ];
  for (const w of system.workflows) lines.push(`- /${w.name}: ${w.description}`);
  lines.push("</workflows>");
  return lines.join("\n");
}

export function buildUserRulesSection(system: PromptSystem): string {
  const lines = ["<user_rules>", USER_RULES_PREAMBLE];
  for (const rule of injectedRules(system)) lines.push(`<MEMORY[${rule.filename}]>\n${rule.content}\n</MEMORY[${rule.filename}]>`);
  lines.push("</user_rules>");
  return lines.join("\n");
}

export function buildUserInformation(ws: WorkspaceInfo): string {
  const lines = ["<user_information>", `The USER's OS is ${ws.os}.`, `The workspace root path is ${ws.workspace}.`];
  if (ws.gitRoot !== undefined) lines.push(`The git repository root is ${ws.gitRoot}.`);
  lines.push("</user_information>");
  return lines.join("\n");
}

export function buildWorkspaceInformation(ws: WorkspaceInfo): string {
  if (ws.tree === undefined) return "<workspace_information>\nNo workspace path available.\n</workspace_information>";
  return ["<workspace_information>", "Below is a snapshot of the workspace file structure at the start of this session. This snapshot will NOT update during the session.", `<workspace_layout workspace="${ws.workspace}">`, ...ws.tree, "</workspace_layout>", "</workspace_information>"].join("\n");
}

export interface TreeOptions {
  maxDepth: number;
  maxLines: number;
  excluded?: readonly string[];
}

function loadGitignore(workspace: string): string[] {
  const path = join(workspace, ".gitignore");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"));
}

/** Minimal .gitignore matcher: directory patterns (`build/`), plain names, `*.ext` globs, and root-anchored `/name`. */
export function gitignoreMatcher(patterns: string[]): (relPath: string, isDir: boolean) => boolean {
  const compiled = patterns.map((raw) => {
    let p = raw;
    const dirOnly = p.endsWith("/");
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.startsWith("/");
    if (anchored) p = p.slice(1);
    const regex = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]")}$`);
    return { regex, dirOnly, anchored, hasSlash: p.includes("/") };
  });
  return (relPath, isDir) => {
    const name = relPath.split("/").pop() ?? relPath;
    return compiled.some((c) => {
      if (c.dirOnly && !isDir) return false;
      if (c.anchored || c.hasSlash) return c.regex.test(relPath);
      return c.regex.test(name) || c.regex.test(relPath);
    });
  };
}

/** Bounded tree walk with .gitignore and the excluded-directory list; computed once at session start (FR-06, DD-09). */
export function workspaceTree(workspace: string, opts: TreeOptions): string[] | undefined {
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) return undefined;
  const excluded = new Set(opts.excluded ?? EXCLUDED_DIRECTORIES);
  const ignored = gitignoreMatcher(loadGitignore(workspace));
  const out: string[] = [];
  let truncated = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > opts.maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch {
      return;
    }
    const dirs: Array<[string, string]> = [];
    for (const name of entries) {
      if (excluded.has(name) || name.endsWith(".egg-info") || name.endsWith("_gitignore")) continue;
      const full = join(dir, name);
      const childRel = rel.length > 0 ? `${rel}/${name}` : name;
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (ignored(childRel, isDir)) continue;
      if (out.length >= opts.maxLines) {
        truncated++;
        continue;
      }
      const indent = "  ".repeat(depth);
      out.push(isDir ? `${indent}- ${name}/` : `${indent}- ${name}`);
      if (isDir) dirs.push([full, childRel]);
    }
    for (const [full, childRel] of dirs) walk(full, childRel, depth + 1);
  };
  walk(workspace, "", 0);
  if (truncated > 0) out.push(`... (${truncated} more)`);
  return out;
}

export function assembleSystemPrompt(system: PromptSystem, ws: WorkspaceInfo): string {
  const sections = [IDENTITY, PRINCIPLES, TOOLS_AND_COMMANDS, DOMAIN_CLAUSES, REPLY_FORMAT, buildWorkflowsSection(system), buildUserRulesSection(system), capabilityNotice(), buildUserInformation(ws), buildWorkspaceInformation(ws), MEMORY_SYSTEM, UNTRUSTED_CONTENT, CLOSING_LINE];
  return sections.join("\n\n");
}

/** Order of the top-level section tags as they appear (for tests and the selftest). */
export function sectionOrder(prompt: string): string[] {
  const known = new Set<string>(SECTION_ORDER);
  const tags: string[] = [];
  const re = /^<([a-z_]+)>$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    if (m[1] !== undefined && known.has(m[1])) tags.push(m[1]);
  }
  return tags;
}
