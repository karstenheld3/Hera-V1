// Category 03 Prompt System (HERAV1STST-SP01 FR-05; HERAV1STST-IP01 IS-04): folder presence, workflow frontmatter,
// SKILL.md per skill folder, the bundled selftest.md - through the same loader the Executor uses.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadPromptSystem } from "../../prompt/loader.ts";
import type { TestResult } from "../report.ts";
import type { SelftestContext } from "../runner.ts";

export async function promptSystemCategory(ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const root = ctx.config.agentFolder;
  const add = (check: string, status: "pass" | "fail", detail: string, error?: string): void => {
    results.push({ category: "03", check, status, duration_seconds: 0, detail, error_message: error ?? null });
  };
  if (!existsSync(root)) {
    add("agent_folder", "fail", "missing", `agent_folder '${root}' does not exist`);
    ctx.out(`  agent_folder: '${root}' missing...FAIL`);
    return results;
  }
  const folderParts: string[] = [];
  for (const sub of ["rules", "workflows", "skills"]) {
    const present = existsSync(join(root, sub)) && statSync(join(root, sub)).isDirectory();
    add(`folder_${sub}`, present ? "pass" : "fail", present ? "present" : "missing", present ? undefined : `'${join(root, sub)}' missing`);
    folderParts.push(`${sub} ${present ? "present" : "MISSING"}`);
  }
  ctx.out(`  folders: ${folderParts.join(", ")}...${results.some((r) => r.status === "fail") ? "FAIL" : "OK"}`);
  const started = performance.now();
  const system = loadPromptSystem(root);
  const loadMs = Math.round(performance.now() - started);
  const frontmatterWarnings = system.warnings.filter((w) => /frontmatter/i.test(w));
  const workflowsDir = join(root, "workflows");
  const workflowFiles = existsSync(workflowsDir) ? readdirSync(workflowsDir).filter((f) => f.endsWith(".md")) : [];
  if (frontmatterWarnings.length === 0) add("workflows", "pass", `${system.workflows.length} of ${workflowFiles.length} parse`);
  else add("workflows", "fail", `${frontmatterWarnings.length} malformed frontmatter`, frontmatterWarnings.join("; "));
  ctx.out(`  workflows: ${system.workflows.length} of ${workflowFiles.length} parse${frontmatterWarnings.length > 0 ? ` (${frontmatterWarnings.length} malformed)` : ""}...${frontmatterWarnings.length === 0 ? "OK" : "FAIL"}`);
  const skillsDir = join(root, "skills");
  const skillFolders = existsSync(skillsDir) ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  const withoutSkillMd = skillFolders.filter((d) => !existsSync(join(skillsDir, d.name, "SKILL.md"))).map((d) => d.name);
  if (withoutSkillMd.length === 0) add("skills", "pass", `${system.skills.length} skills with SKILL.md`);
  else add("skills", "fail", `${withoutSkillMd.length} folder(s) without SKILL.md`, `skill folders without SKILL.md: ${withoutSkillMd.join(", ")}`);
  ctx.out(`  skills: ${system.skills.length} with SKILL.md${withoutSkillMd.length > 0 ? `, missing in ${withoutSkillMd.join(", ")}` : ""}...${withoutSkillMd.length === 0 ? "OK" : "FAIL"}`);
  add("rules", "pass", `${system.rules.length} rules, loaded in ${loadMs} ms`);
  ctx.out(`  rules: ${system.rules.length} loaded in ${loadMs} ms...OK`);
  const selftestMd = existsSync(join(workflowsDir, "selftest.md"));
  add("selftest_workflow", selftestMd ? "pass" : "fail", selftestMd ? "workflows/selftest.md present" : "workflows/selftest.md missing", selftestMd ? undefined : `'${join(workflowsDir, "selftest.md")}' missing - the /selftest workflow cannot run`);
  ctx.out(`  selftest.md: ${selftestMd ? "present" : "missing"}...${selftestMd ? "OK" : "FAIL"}`);
  return results;
}
