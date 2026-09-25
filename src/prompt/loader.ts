// Prompt system loading (HERAV1PRCF-SP01 FR-04, FR-07; HERAV1PRCF-IP01 IS-05). Port of V1 loader.py.
// Frontmatter parsed locally via js-yaml; every parse failure degrades to body-only with a warning, never a crash (EC-11).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { load as yamlLoad } from "js-yaml";

export interface RuleFile {
  filename: string;
  trigger: string | undefined;
  content: string;
  /** undefined = injected; "empty" = injected as an empty block but counted as skipped; "trigger" = not injected */
  skippedReason: "empty" | "trigger" | undefined;
}

export interface WorkflowFile {
  name: string;
  description: string;
  content: string;
  path: string;
}

export interface SkillFolder {
  name: string;
  description: string;
  content: string;
  supportingFiles: string[];
  path: string;
}

export interface PromptSystem {
  root: string;
  rules: RuleFile[];
  workflows: WorkflowFile[];
  skills: SkillFolder[];
  warnings: string[];
  created: string[];
}

export const BUILTIN_COMMANDS = ["help", "cost", "status", "ask", "exit"] as const;

export interface FrontmatterResult {
  data: Record<string, unknown>;
  body: string;
  warning: string | undefined;
}

export function parseFrontmatter(text: string, sourceName: string): FrontmatterResult {
  if (!text.startsWith("---")) return { data: {}, body: text, warning: undefined };
  try {
    const lines = text.split(/\r?\n/);
    const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (closeIdx <= 0) throw new Error("unclosed frontmatter delimiter");
    const yamlBlock = lines.slice(1, closeIdx).join("\n");
    const body = lines.slice(closeIdx + 1).join("\n");
    const loaded = yamlLoad(yamlBlock);
    const data = typeof loaded === "object" && loaded !== null ? (loaded as Record<string, unknown>) : {};
    return { data, body, warning: undefined };
  } catch (error) {
    const lines = text.split(/\r?\n/);
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    const body = close > 0 ? lines.slice(close + 1).join("\n") : text;
    return { data: {}, body, warning: `WARNING: malformed YAML frontmatter in '${sourceName}' -> treated as body-only (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).` };
  }
}

export function truncateBlock(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n<truncated ${content.length - maxChars} chars>`;
}

const readText = (path: string): string => readFileSync(path, "utf8").replace(/^\uFEFF/, "");

const listMd = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort() : []);

export function loadRule(path: string, filename: string, maxChars: number, warnings: string[]): RuleFile {
  const { data, body, warning } = parseFrontmatter(readText(path), filename);
  if (warning !== undefined) warnings.push(warning);
  const trigger = typeof data["trigger"] === "string" ? (data["trigger"] as string) : undefined;
  if (trigger !== undefined && trigger !== "always_on") return { filename, trigger, content: "", skippedReason: "trigger" };
  const trimmed = body.trim();
  if (trimmed.length === 0) return { filename, trigger, content: "", skippedReason: "empty" };
  return { filename, trigger, content: truncateBlock(trimmed, maxChars), skippedReason: undefined };
}

export function loadWorkflow(path: string, filename: string, warnings: string[]): WorkflowFile {
  const { data, body, warning } = parseFrontmatter(readText(path), filename);
  if (warning !== undefined) warnings.push(warning);
  const description = data["description"];
  return { name: filename.replace(/\.md$/i, ""), description: typeof description === "string" ? description.trim() : "", content: body.trim(), path };
}

function walkFiles(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile()) out.push(relative(base, full).replace(/\\/g, "/"));
  }
}

export function loadSkill(folder: string, warnings: string[]): SkillFolder | undefined {
  const skillMd = join(folder, "SKILL.md");
  const folderName = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? folder;
  if (!existsSync(skillMd)) {
    warnings.push(`WARNING: skill folder '${folderName}' has no SKILL.md -> skipped.`);
    return undefined;
  }
  const { data, body, warning } = parseFrontmatter(readText(skillMd), `${folderName}/SKILL.md`);
  if (warning !== undefined) warnings.push(warning);
  const files: string[] = [];
  walkFiles(folder, folder, files);
  const supportingFiles = files.filter((f) => f !== "SKILL.md").sort();
  const name = typeof data["name"] === "string" && (data["name"] as string).trim().length > 0 ? (data["name"] as string).trim() : folderName;
  const description = typeof data["description"] === "string" ? (data["description"] as string).trim() : "";
  return { name, description, content: body.trim(), supportingFiles, path: folder };
}

export interface LoadOptions {
  ruleBlockMaxChars?: number;
  /** create rules/, workflows/, skills/ when the folder is missing (zero-setup, EC-09) */
  scaffold?: boolean;
}

/** Loads the whole prompt system (Executor). Missing folder → scaffold with `Created` entries; empty system → NOTICE. */
export function loadPromptSystem(agentFolder: string, opts: LoadOptions = {}): PromptSystem {
  const maxChars = opts.ruleBlockMaxChars ?? 6000;
  const system: PromptSystem = { root: agentFolder, rules: [], workflows: [], skills: [], warnings: [], created: [] };
  if (!existsSync(agentFolder)) {
    if (opts.scaffold === false) {
      system.warnings.push(`WARNING: prompt system folder '${agentFolder}' not found.`);
      return system;
    }
    for (const sub of ["rules", "workflows", "skills"]) {
      const dir = join(agentFolder, sub);
      mkdirSync(dir, { recursive: true });
      system.created.push(dir);
    }
  }
  system.rules = loadRules(agentFolder, maxChars, system.warnings);
  const wfDir = join(agentFolder, "workflows");
  system.workflows = listMd(wfDir).map((f) => loadWorkflow(join(wfDir, f), f, system.warnings));
  for (const name of BUILTIN_COMMANDS) {
    if (system.workflows.some((w) => w.name === name)) system.warnings.push(`WARNING: workflow '${name}.md' collides with the built-in command /${name} - the built-in wins.`);
  }
  const skillsDir = join(agentFolder, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir).sort()) {
      const folder = join(skillsDir, entry);
      if (!statSync(folder).isDirectory()) continue;
      const skill = loadSkill(folder, system.warnings);
      if (skill !== undefined) system.skills.push(skill);
    }
  }
  if (system.rules.length === 0 && system.workflows.length === 0 && system.skills.length === 0) {
    system.warnings.push(`NOTICE: prompt system '${agentFolder}' is empty -> no rules, workflows, or skills loaded.`);
  }
  return system;
}

/** Supervisor scope (FR-07): rules only. */
export function loadRules(agentFolder: string, maxChars = 6000, warnings: string[] = []): RuleFile[] {
  const dir = join(agentFolder, "rules");
  return listMd(dir).map((f) => loadRule(join(dir, f), f, maxChars, warnings));
}

/** Communicator scope (FR-07): workflow names and descriptions only. */
export function loadWorkflowIndex(agentFolder: string, warnings: string[] = []): Array<{ name: string; description: string }> {
  const dir = join(agentFolder, "workflows");
  return listMd(dir).map((f) => {
    const w = loadWorkflow(join(dir, f), f, warnings);
    return { name: w.name, description: w.description };
  });
}

export function injectedRules(system: PromptSystem): RuleFile[] {
  return system.rules.filter((r) => r.skippedReason !== "trigger");
}

export function findWorkflow(system: PromptSystem, name: string): WorkflowFile | undefined {
  return system.workflows.find((w) => w.name === name);
}

export function findSkill(system: PromptSystem, name: string): SkillFolder | undefined {
  return system.skills.find((s) => s.name === name);
}

/** `8 rules (7 injected, 1 skipped: empty), 46 workflows, 24 skills.` */
export function countsLine(system: PromptSystem): string {
  const injected = system.rules.filter((r) => r.skippedReason === undefined).length;
  const skipped = system.rules.filter((r) => r.skippedReason !== undefined);
  const byReason = new Map<string, number>();
  for (const r of skipped) byReason.set(r.skippedReason as string, (byReason.get(r.skippedReason as string) ?? 0) + 1);
  const reasons = [...byReason.entries()].sort(([a], [b]) => a.localeCompare(b));
  const skippedText = skipped.length > 0 ? `, ${skipped.length} skipped: ${reasons.map(([k, v]) => (v > 1 ? `${v} ${k}` : k)).join(", ")}` : "";
  return `${system.rules.length} rules (${injected} injected${skippedText}), ${system.workflows.length} workflows, ${system.skills.length} skills.`;
}
