import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRegistry, ParameterMapping, PricingTable } from "../../src/config/load.ts";
import { cheapestPerMethod, levelsFor, prefixFor, testableModels } from "../../src/selftest/discovery.ts";
import { ResultsWriter, categorySummaryLine, exitCodeFor, menuText, resultLine, summarize, type TestResult } from "../../src/selftest/report.ts";
import { ALL_CODES, Budget, LIVE_CODES, OFFLINE_CODES, categories, parseSelftestArgs } from "../../src/selftest/runner.ts";
import pkg from "../../package.json" with { type: "json" };

const TMP = join(import.meta.dir, "..", ".tmp", "selftest_units");
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

const registry: ModelRegistry = {
  models: [
    { provider: "openai", model_id: "gpt-4.1-mini", enabled: true, status: "available" },
    { provider: "openai", model_id: "gpt-5.6-terra", enabled: true, status: "available" },
    { provider: "zai", model_id: "glm-5.2", enabled: true, status: "available" },
    { provider: "anthropic", model_id: "claude-opus-4.7", enabled: true, status: "available" },
    { provider: "openai", model_id: "gpt-old", enabled: false },
    { provider: "openai", model_id: "gpt-preview", enabled: true, status: "preview" },
    { provider: "zai", model_id: "mystery-9", enabled: true, status: "available" },
  ],
  model_id_startswith: [
    { prefix: "gpt-4.1", provider: "openai", method: "temperature", default: "medium" },
    { prefix: "gpt-5", provider: "openai", method: "reasoning_effort", effort: ["low", "medium", "high"], default: "high" },
    { prefix: "glm-", provider: "zai", method: "thinking", default: "high" },
    { prefix: "claude-", provider: "anthropic", method: "adaptive_thinking", effort: ["low", "medium", "high", "max"] },
  ],
};
const mapping: ParameterMapping = { effort_levels: ["minimal", "low", "medium", "high"], effort_mapping: {} };
const pricing: PricingTable = { openai: { "gpt-4.1-mini": { input_per_1m: 0.4, output_per_1m: 1.6 }, "gpt-5.6-terra": { input_per_1m: 2, output_per_1m: 8 } }, zai: { "glm-5.2": { input_per_1m: 1, output_per_1m: 3 } }, anthropic: {} };

const result = (category: string, check: string, status: TestResult["status"], cost = 0): TestResult => ({ category, check, status, duration_seconds: 0, error_message: status === "fail" || status === "error" ? "x" : null, cost_usd: cost });

describe("HERAV1STST-TP01 framework", () => {
  test("HERAV1STST-IP01-TC-01/03 menu layout and the code expansions; no codes → menu only", () => {
    const text = menuText(categories(undefined));
    expect(text.split("\n")[0]).toBe("SELFTEST MENU");
    expect(text).toContain("  01  Environment          offline  free");
    expect(text).toContain("  08  Roles                live     ~$0.02 (4 roles)");
    expect(text).toContain("  09  Harness Conformance  offline  free");
    expect(text).toContain("  10  LocalGuards Controls offline  free");
    expect(text).toContain("Usage: hera selftest <codes...> | all | offline | live");
    expect(parseSelftestArgs(["selftest"]).codes).toEqual([]);
    expect(parseSelftestArgs(["selftest", "--menu"]).menu).toBe(true);
    expect(parseSelftestArgs(["offline"]).codes).toEqual(OFFLINE_CODES);
    expect(parseSelftestArgs(["live"]).codes).toEqual(LIVE_CODES);
    expect(parseSelftestArgs(["all"]).codes).toEqual(ALL_CODES);
    expect(parseSelftestArgs(["01", "--provider", "zai"]).provider).toBe("zai");
    expect(parseSelftestArgs(["01", "--budget", "0.3", "--timeout", "5", "--model", "glm-5.2"])).toMatchObject({ budgetUsd: 0.3, timeoutS: 5, model: "glm-5.2" });
    expect(parseSelftestArgs([]).budgetUsd).toBe(5);
  });

  test("HERAV1STST-IP01-TC-02 invalid codes error listing the valid ones; duplicates once; unordered → ascending", () => {
    for (const bad of ["11", "1", "env"]) expect(() => parseSelftestArgs([bad])).toThrow(/Valid: 01 02 03 04 05 06 07 08 09 10 | all | offline | live/);
    expect(parseSelftestArgs(["01", "01"]).codes).toEqual(["01"]);
    expect(parseSelftestArgs(["04", "01"]).codes).toEqual(["01", "04"]);
    expect(() => parseSelftestArgs(["--budget"])).toThrow(/requires a value/);
    expect(() => parseSelftestArgs(["--budget", "-1"])).toThrow(/non-negative/);
  });

  test("HERAV1STST-IP01-TC-04 budget gate: the first test exceeding the remainder stops all later ones; under 0.01 nothing passes; --budget 0 blocks everything", () => {
    const budget = new Budget(0.05);
    expect(budget.beforeTest()).toBe(true);
    budget.record(0.02);
    expect(budget.beforeTest()).toBe(true);
    budget.record(0.025);
    expect(budget.remaining).toBeCloseTo(0.005, 6);
    expect(budget.beforeTest()).toBe(false);
    budget.record(0.01);
    expect(budget.beforeTest()).toBe(false);
    expect(new Budget(0).beforeTest()).toBe(false);
    expect(new Budget(0.01).beforeTest()).toBe(true);
  });

  test("HERAV1STST-IP01-TC-05/07 results writer: valid JSON after an interrupt with the completed records; fallback dir when data_dir is not writable", () => {
    mkdirSync(TMP, { recursive: true });
    const writer = new ResultsWriter(join(TMP, "data"), 5, true, new Date(2026, 8, 6, 8, 5, 0));
    expect(writer.path.replace(/\\/g, "/")).toContain("/data/selftest/2026-09-06_08-05-00/results.json");
    writer.categoriesRun.push("01", "08");
    writer.add(result("01", "bun_version", "pass"));
    writer.add(result("08", "generating", "pass", 0.0002));
    writer.add(result("08", "memory", "skip"));
    const doc = writer.flush(true);
    const onDisk = JSON.parse(readFileSync(writer.path, "utf8")) as typeof doc;
    expect(onDisk.summary).toEqual({ pass: 2, fail: 0, skip: 1, error: 0, budget_exceeded: 0, interrupted: true });
    expect(onDisk.tests).toHaveLength(3);
    expect(onDisk.categories_run).toEqual(["01", "08"]);
    expect(onDisk.cost_usd).toBe(0.0002);
    expect(onDisk.hera_version).toBe(pkg.version);
    expect(onDisk.scripted).toBe(true);
    expect(existsSync(`${writer.path}.tmp`)).toBe(false);
    // a second flush overwrites atomically
    writer.add(result("08", "supervisor", "fail"));
    expect(writer.flush().summary.fail).toBe(1);
    const blocker = join(TMP, "blocked");
    writeFileSync(blocker, "not a directory");
    const fallback = new ResultsWriter(blocker, 5, false);
    expect(fallback.fallbackWarning).toMatch(/^WARNING: .*not writable .* - results\.json written to /);
    expect(fallback.path.replace(/\\/g, "/")).toContain("/hera-selftest/");
    fallback.flush();
    expect(existsSync(fallback.path)).toBe(true);
    rmSync(join(fallback.path, "..", ".."), { recursive: true, force: true });
  });

  test("HERAV1STST-IP01-TC-06 exit code: only skips → 0; one fail → 1; one error → 1; budget_exceeded only → 0", () => {
    expect(exitCodeFor(summarize([result("04", "a", "skip"), result("04", "b", "skip")]))).toBe(0);
    expect(exitCodeFor(summarize([result("04", "a", "pass"), result("04", "b", "fail")]))).toBe(1);
    expect(exitCodeFor(summarize([result("04", "a", "error")]))).toBe(1);
    expect(exitCodeFor(summarize([result("04", "a", "budget_exceeded"), result("04", "b", "budget_exceeded")]))).toBe(0);
    expect(exitCodeFor(summarize([]))).toBe(0);
    expect(resultLine({ pass: 20, fail: 0, skip: 0, error: 0, budget_exceeded: 0 }, 0.0002, 12.4)).toBe("RESULT: 20 passed, 0 failed, 0 skipped | $0.0002 | 12.4 secs");
    expect(resultLine({ pass: 1, fail: 1, skip: 2, error: 1, budget_exceeded: 3, interrupted: true }, 0, 1)).toBe("RESULT: 1 passed, 1 failed, 2 skipped, 1 errors, 3 over budget | $0.0000 | 1.0 secs | INTERRUPTED");
    expect(categorySummaryLine("07", "Process Health", [result("07", "a", "pass"), result("07", "b", "pass")])).toBe("  07 Process Health: 2 passed.");
  });
});

describe("HERAV1STST-TP01 discovery", () => {
  test("HERAV1STST-IP01-TC-08/09 disabled, non-available, and no-prefix models excluded (warning); missing key → skip pre-mark, never fail", () => {
    const d = testableModels(registry, mapping, pricing, new Set(["openai", "zai"]));
    expect(d.testable.map((t) => t.model.model_id)).toEqual(["gpt-4.1-mini", "gpt-5.6-terra", "glm-5.2", "claude-opus-4.7"]);
    expect(d.warnings).toEqual(["WARNING: model 'mystery-9' has no model_id_startswith entry -> excluded from the sweep."]);
    const claude = d.testable.find((t) => t.provider === "anthropic");
    expect(claude?.keyPresent).toBe(false);
    expect(claude?.levels).toEqual(["low", "medium", "high", "max"]);
    expect(claude?.defaultEffort).toBe("medium");
    expect(d.testable.find((t) => t.model.model_id === "gpt-5.6-terra")?.defaultEffort).toBe("high");
    expect(d.testable.find((t) => t.model.model_id === "glm-5.2")?.levels).toEqual(["low", "medium", "high"]);
    expect(prefixFor("gpt-5.6-terra", registry)?.prefix).toBe("gpt-5");
    expect(levelsFor({ prefix: "x", provider: "openai", method: "reasoning_effort" }, mapping)).toEqual(mapping.effort_levels);
  });

  test("HERAV1STST-IP01-TC-10/11 cheapest per method by input price (unpriced never wins); --provider and --model filters", () => {
    const d = testableModels(registry, mapping, pricing, new Set(["openai", "zai", "anthropic"]));
    const cheapest = cheapestPerMethod(d.testable);
    expect(cheapest.get("temperature")?.model.model_id).toBe("gpt-4.1-mini");
    expect(cheapest.get("reasoning_effort")?.model.model_id).toBe("gpt-5.6-terra");
    expect(cheapest.get("thinking")?.model.model_id).toBe("glm-5.2");
    expect(cheapest.has("adaptive_thinking")).toBe(false); // claude is unpriced in this fixture
    expect(testableModels(registry, mapping, pricing, new Set(), { provider: "zai" }).testable.map((t) => t.model.model_id)).toEqual(["glm-5.2"]);
    expect(testableModels(registry, mapping, pricing, new Set(), { model: "gpt-4.1-mini" }).testable).toHaveLength(1);
    expect(testableModels(registry, mapping, pricing, new Set(), { model: "nope" }).testable).toHaveLength(0);
  });
});

describe("HERAV1STST-TP01 category 10 LocalGuards Controls", () => {
  test("seven checks registered and named", () => {
    const cats = categories(undefined);
    const cat10 = cats.find((c) => c.code === "10");
    expect(cat10).toBeDefined();
    expect(cat10?.name).toBe("LocalGuards Controls");
    expect(cat10?.costClass).toBe("offline");
    expect(OFFLINE_CODES).toContain("10");
    expect(ALL_CODES).toContain("10");
  });
});

describe("HERAV1STST-TP01 thin workflow", () => {
  test("HERAV1STST-IP01-TC-26 workflows/selftest.md is a thin caller: menu call, ask_user_question, cost statement, no interpreter or script path", () => {
    const path = join(import.meta.dir, "..", "..", ".agent", "workflows", "selftest.md");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("selftest --menu");
    expect(text).toContain("ask_user_question");
    expect(text).toMatch(/estimated cost/i);
    expect(text).toMatch(/--budget 5\.00/);
    expect(text).not.toMatch(/python|\.py\b|\.ps1\b|selftest\.py|skills\/selftest/i);
    expect(text).toMatch(/^description: /m);
  });
});
