import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptSystemContentHash } from "../../src/harness/definition_hash.ts";
import { countsLine, injectedRules, loadPromptSystem, loadRules, loadWorkflowIndex, parseFrontmatter, truncateBlock } from "../../src/prompt/loader.ts";
import { REPO_ROOT, makeTempDir, removeDir } from "../harness/procs.ts";

const FAKE_SYSTEM = join(REPO_ROOT, "tests", "fixtures", "fake_system");
const REAL_IPPS = "e:\\Dev\\Hera-V0\\.agent";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("HERAV1PRCF-TP01 prompt system loading", () => {
  test("HERAV1PRCF-TP01-TC-19 fake_system: counts, trigger skip, truncation marker, empty rule injected empty and counted skipped", () => {
    const system = loadPromptSystem(FAKE_SYSTEM, { ruleBlockMaxChars: 500 });
    expect(system.rules).toHaveLength(4);
    expect(system.workflows).toHaveLength(3);
    expect(system.skills).toHaveLength(2);
    const byName = Object.fromEntries(system.rules.map((r) => [r.filename, r]));
    expect(byName["model-only.md"]?.skippedReason).toBe("trigger");
    expect(byName["workspace-rules.md"]?.skippedReason).toBe("empty");
    expect(byName["workspace-rules.md"]?.content).toBe("");
    expect(byName["oversized.md"]?.content).toMatch(/\n<truncated \d+ chars>$/);
    expect(byName["oversized.md"]?.content.length).toBeLessThan(560);
    expect(byName["coding-style.md"]?.content).toContain("# Coding Style");
    expect(byName["coding-style.md"]?.content.startsWith("---")).toBe(false);
    expect(injectedRules(system).map((r) => r.filename)).toEqual(["coding-style.md", "oversized.md", "workspace-rules.md"]);
    expect(countsLine(system)).toBe("4 rules (2 injected, 2 skipped: empty, trigger), 3 workflows, 2 skills.");
    expect(system.created).toEqual([]);
  });

  test("HERAV1PRCF-TP01-TC-20 workflow with broken frontmatter loads with empty description and one warning", () => {
    const system = loadPromptSystem(FAKE_SYSTEM);
    const broken = system.workflows.find((w) => w.name === "broken");
    expect(broken).toBeDefined();
    expect(broken?.description).toBe("");
    expect(broken?.content).toContain("Broken Frontmatter Workflow");
    expect(system.warnings.filter((w) => w.includes("broken.md"))).toHaveLength(1);
    const prime = system.workflows.find((w) => w.name === "prime");
    expect(prime?.description).toBe("Prime context with workspace files");
    expect(prime?.content.startsWith("# Prime Workflow")).toBe(true);
    const fm = parseFrontmatter("---\ntrigger: always_on\n---\n\nbody", "x.md");
    expect(fm.data["trigger"]).toBe("always_on");
    expect(fm.body.trim()).toBe("body");
    expect(parseFrontmatter("no frontmatter", "y.md").body).toBe("no frontmatter");
  });

  test("HERAV1PRCF-TP01-TC-21 skill without SKILL.md skipped with warning; supporting files sorted and relative", () => {
    const system = loadPromptSystem(FAKE_SYSTEM);
    expect(system.skills.map((s) => s.name)).toEqual(["plain-skill", "sample-skill"]);
    expect(system.warnings.some((w) => w.includes("no-skill-md") && w.includes("SKILL.md"))).toBe(true);
    const sample = system.skills.find((s) => s.name === "sample-skill");
    expect(sample?.supportingFiles).toEqual(["references/CHECKS.md", "references/GUIDE.md"]);
    expect(sample?.description).toBe("Apply when a sample skill is needed");
    expect(system.skills.find((s) => s.name === "plain-skill")?.supportingFiles).toEqual([]);
  });

  test("HERAV1PRCF-TP01-TC-22 content hash stable across loads; one byte change flips the hash", () => {
    const dir = makeTempDir("fp");
    dirs.push(dir);
    cpSync(FAKE_SYSTEM, dir, { recursive: true });
    const a = promptSystemContentHash(loadPromptSystem(dir));
    const b = promptSystemContentHash(loadPromptSystem(dir));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    const rulePath = join(dir, "rules", "coding-style.md");
    writeFileSync(rulePath, `${readFileSync(rulePath, "utf8")}x`);
    const c = promptSystemContentHash(loadPromptSystem(dir));
    expect(c).not.toBe(a);
  });

  test("HERAV1PRCF-TP01-TC-23 missing agent folder scaffolded with Created entries; empty system yields one NOTICE", () => {
    const dir = makeTempDir("scaffold");
    dirs.push(dir);
    const agent = join(dir, ".agent");
    const system = loadPromptSystem(agent);
    expect(existsSync(join(agent, "rules"))).toBe(true);
    expect(existsSync(join(agent, "workflows"))).toBe(true);
    expect(existsSync(join(agent, "skills"))).toBe(true);
    expect(system.created).toHaveLength(3);
    expect(system.warnings.filter((w) => w.startsWith("NOTICE:") && w.includes("empty"))).toHaveLength(1);
    const emptyDir = join(dir, "empty_system");
    mkdirSync(join(emptyDir, "rules"), { recursive: true });
    const empty = loadPromptSystem(emptyDir);
    expect(empty.created).toEqual([]);
    expect(empty.warnings.filter((w) => w.startsWith("NOTICE:"))).toHaveLength(1);
  });

  test("HERAV1PRCF-TP01-TC-24 loadRules and loadWorkflowIndex read only their folders", () => {
    const dir = makeTempDir("scoped");
    dirs.push(dir);
    mkdirSync(join(dir, "rules"), { recursive: true });
    writeFileSync(join(dir, "rules", "a.md"), "---\ntrigger: always_on\n---\n# A\n");
    // no workflows/ or skills/ folders: the scoped loaders must not need them
    const rules = loadRules(dir);
    expect(rules.map((r) => r.filename)).toEqual(["a.md"]);
    expect(loadWorkflowIndex(dir)).toEqual([]);
    const index = loadWorkflowIndex(FAKE_SYSTEM);
    expect(index).toEqual([
      { name: "broken", description: "" },
      { name: "commit", description: "Create conventional commits" },
      { name: "prime", description: "Prime context with workspace files" },
    ]);
    expect(truncateBlock("abcdef", 3)).toBe("abc\n<truncated 3 chars>");
  });

  test.skipIf(!existsSync(REAL_IPPS))("HERAV1PRCF-TP01-TC-25 the real IPPS folder loads without error", () => {
    const system = loadPromptSystem(REAL_IPPS);
    expect(system.rules.length).toBeGreaterThan(0);
    expect(system.workflows.length).toBeGreaterThan(0);
    expect(system.skills.length).toBeGreaterThan(0);
    const line = countsLine(system);
    expect(line).toMatch(/^\d+ rules \(\d+ injected.*\), \d+ workflows, \d+ skills\.$/);
    process.stderr.write(`  IPPS: ${line} (${system.warnings.length} warnings)\n`);
  });
});
