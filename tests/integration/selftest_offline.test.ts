import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/args.ts";
import type { ModelRegistry, ParameterMapping, PricingTable } from "../../src/config/load.ts";
import { cheapestPerMethod, testableModels } from "../../src/selftest/discovery.ts";
import type { ResultsDocument } from "../../src/selftest/report.ts";
import { selftestMain } from "../../src/selftest/runner.ts";
import { assertNoSecretLeak } from "../harness/assertions.ts";
import { FAKE_SYSTEM, SCRIPTS, prepareRig } from "../harness/executor_rig.ts";
import { REPO_ROOT, removeDir } from "../harness/procs.ts";

const DECOY = "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789";
const ENTRY = join(REPO_ROOT, "src", "index.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

interface Run {
  code: number;
  out: string;
  err: string;
  results: ResultsDocument | undefined;
}

async function runSelftest(argv: string[], appDir: string, env: Record<string, string | undefined>, sigint?: (fire: () => void) => void): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const args = parseArgs(["selftest", ...argv]);
  const code = await selftestMain(args, { out: (l) => out.push(l), err: (l) => err.push(l), env: { ...env, AGENT_APP_DIR: appDir, HERA_DECOY_KEY: DECOY }, cwd: appDir, entryMain: ENTRY, onSigint: (h) => sigint?.(h) });
  const text = out.join("\n");
  const match = /^results\.json: (.+)$/m.exec(text);
  const results = match !== null && existsSync(match[1] as string) ? (JSON.parse(readFileSync(match[1] as string, "utf8")) as ResultsDocument) : undefined;
  return { code, out: text, err: err.join("\n"), results };
}

function rig(opts: { agentFolder?: string; script?: string; configOverrides?: Record<string, unknown>; withRg?: boolean } = {}): { appDir: string; env: Record<string, string> } {
  const prepared = prepareRig({ script: join(SCRIPTS, opts.script ?? "script_exec_basic.jsonl"), agentFolder: opts.agentFolder ?? FAKE_SYSTEM, configOverrides: opts.configOverrides });
  dirs.push(...prepared.dirs);
  if (opts.withRg !== false) {
    mkdirSync(join(prepared.appDir, ".agent-tools"), { recursive: true });
    copyFileSync(join(REPO_ROOT, ".agent-tools", "rg.exe"), join(prepared.appDir, ".agent-tools", "rg.exe"));
  }
  const env: Record<string, string> = { ...prepared.env };
  delete env["HERA_DEBUG_LINES"];
  return { appDir: prepared.appDir, env };
}

const byCheck = (r: ResultsDocument, category: string): Record<string, string> => Object.fromEntries(r.tests.filter((t) => t.category === category).map((t) => [t.check, t.status]));

describe("[integration] HERAV1STST-TP01 offline categories (in-process runner, real children for 07)", () => {
  test("HERAV1STST-IP01-TC-12/13/16 offline on a clean rig: 01 versions and platform pass, hosts pass or fail by name; 02 roles with default marks, keys without values, pricing coverage; 07 all checks pass, no survivor; results.json valid; exit 0 when hosts are reachable", async () => {
    const clean = join(dirs.length > 0 ? dirs[0] as string : "", "");
    void clean;
    const { appDir, env } = rig({ agentFolder: join(REPO_ROOT, "tests", "fixtures", "fake_system") });
    // a clean prompt system: the fixture has a broken workflow and a skill without SKILL.md, so run 01, 02, 07 here and 03 separately
    const run = await runSelftest(["01", "02", "07"], appDir, env);
    expect(run.results).toBeDefined();
    const r = run.results as ResultsDocument;
    expect(r.categories_run).toEqual(["01", "02", "07"]);
    const c01 = byCheck(r, "01");
    expect(c01["bun_version"]).toBe("pass");
    expect(c01["hera_version"]).toBe("pass");
    expect(c01["platform"]).toBe("pass");
    expect(c01["data_dir"]).toBe("pass");
    for (const host of ["api.openai.com", "api.anthropic.com", "api.z.ai"]) expect(["pass", "fail"]).toContain(c01[host]);
    const hostFails = Object.entries(c01).filter(([k, v]) => k.startsWith("api.") && v === "fail").length;
    const c02 = byCheck(r, "02");
    expect(c02["agent-config.json"]).toBe("pass");
    for (const role of ["generating", "compacting", "supervisor", "memory"]) expect(c02[`role_${role}`]).toBe("pass");
    expect(run.out).toMatch(/compacting gpt-4\.1-mini \(low, default\)/);
    expect(run.out).toMatch(/keys: .*openai (present|missing)/);
    expect(run.out).not.toContain(DECOY);
    expect(c02["websearch"]).toBe("pass");
    expect(c02["pricing"]).toBe("pass");
    expect(run.out).toMatch(/pricing: \d+ of \d+ enabled models priced/);
    expect(run.out).toContain("supervisor: stall_timeout_s");
    const c07 = byCheck(r, "07");
    for (const check of ["hello_executor", "hello_supervisor", "session_open_ack", "heartbeat_executor", "heartbeat_supervisor", "shutdown_executor", "shutdown_supervisor", "rg_present", "rg_version", "ready_ms"]) expect(c07[check]).toBe("pass");
    expect(c07["survivors"]).toBeUndefined();
    expect(run.out).toMatch(/rg\.exe: ripgrep \d+\.\d+/);
    expect(r.summary.fail).toBe(hostFails);
    expect(run.code).toBe(hostFails === 0 ? 0 : 1);
    expect(r.scripted).toBe(true);
    // no child alive after the category (filter by appDir to avoid counting other parallel tests' children)
    await Bun.sleep(200);
    const escapedAppDir = appDir.replace(/\\/g, "\\\\").replace(/'/g, "''");
    const alive = Bun.spawnSync(["powershell", "-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" | Where-Object { $_.CommandLine -match '--role (executor|supervisor)' -and $_.CommandLine -match '${escapedAppDir}' } | Measure-Object).Count`], { stdout: "pipe", stderr: "ignore" });
    expect(Number(new TextDecoder().decode(alive.stdout).trim() || "0")).toBe(0);
    assertNoSecretLeak([run.out, run.err, JSON.stringify(r)], undefined, [DECOY]);
  }, 60000);

  test("HERAV1STST-IP01-TC-24 category 09: harness conformance checks all pass offline", async () => {
    const { appDir, env } = rig();
    const run = await runSelftest(["09"], appDir, env);
    expect(run.results).toBeDefined();
    const r = run.results as ResultsDocument;
    expect(r.categories_run).toEqual(["09"]);
    const c09 = byCheck(r, "09");
    for (const check of ["admit_run_ctx", "allow_answer", "block_answer", "unavailable_answer", "pending_resolve", "halt_state", "descriptor_shape", "network_free"]) expect(c09[check]).toBe("pass");
    expect(r.summary.fail).toBe(0);
    expect(r.summary.error).toBe(0);
    expect(run.code).toBe(0);
  }, 30000);

  test("HERAV1STST-IP01-TC-25 category 10: LocalGuards Controls seven checks all pass offline", async () => {
    const { appDir, env } = rig();
    const run = await runSelftest(["10"], appDir, env);
    expect(run.results).toBeDefined();
    const r = run.results as ResultsDocument;
    expect(r.categories_run).toEqual(["10"]);
    const c10 = byCheck(r, "10");
    for (const check of ["read_outside_workspace_blocked", "protected_path_blocked", "key_shape_in_url_blocked", "governed_refused", "run_command_pending", "tool_result_delimited", "tampered_memory_dropped"]) expect(c10[check]).toBe("pass");
    expect(r.summary.fail).toBe(0);
    expect(r.summary.error).toBe(0);
    expect(run.code).toBe(0);
  }, 30000);

  test("HERAV1STST-IP01-TC-15 category 03: fixture with a malformed workflow and a skill folder without SKILL.md → both fail, selftest.md presence check", async () => {
    const { appDir, env } = rig();
    const run = await runSelftest(["03"], appDir, env);
    const c03 = byCheck(run.results as ResultsDocument, "03");
    expect(c03["folder_rules"]).toBe("pass");
    expect(c03["workflows"]).toBe("fail");
    expect(c03["skills"]).toBe("fail");
    expect(c03["selftest_workflow"]).toBe("fail");
    expect(run.out).toContain("malformed");
    expect(run.out).toContain("no-skill-md");
    expect(run.code).toBe(1);
    // the real IPPS library passes when present
    const ipps = "e:\\Dev\\Hera-V0\\.agent";
    if (existsSync(ipps)) {
      const clean = rig({ agentFolder: ipps });
      const ok = await runSelftest(["03"], clean.appDir, clean.env);
      const c = byCheck(ok.results as ResultsDocument, "03");
      expect(Object.values(c).every((s) => s === "pass")).toBe(true);
      expect(ok.code).toBe(0);
    }
  }, 30000);

  test("HERAV1STST-IP01-TC-14/18 02 with a mixed-shape config → fail naming the key; 07 materializes rg.exe automatically; missing default config → auto-created and pass", async () => {
    const { appDir, env } = rig({ withRg: false });
    writeFileSync(join(appDir, ".agent-data", "config", "agent-config.json"), JSON.stringify({ roles: { generating: { model_id: "glm-5.2", effort: "high" } }, generator_model: "gpt-4.1" }));
    const mixed = await runSelftest(["02"], appDir, env);
    expect(mixed.code).toBe(2); // the loader refuses the mixed shape before any category runs
    expect(mixed.err).toMatch(/generator_model|mixed/i);
    writeFileSync(join(appDir, ".agent-data", "config", "agent-config.json"), JSON.stringify({ roles: { generating: { model_id: "glm-5.2", effort: "high" } }, agent_folder: FAKE_SYSTEM }));
    // materialize() in selftestMain auto-creates rg.exe, so rg_present should pass
    const noRg = await runSelftest(["07"], appDir, env);
    const c07 = byCheck(noRg.results as ResultsDocument, "07");
    expect(c07["rg_present"]).toBe("pass");
    expect(noRg.code).toBe(0);
    // missing default config: zero-setup creates it, category 02 reports created
    const fresh = rig();
    const cfgPath = join(fresh.appDir, ".agent-data", "config", "agent-config.json");
    const original = readFileSync(cfgPath, "utf8");
    writeFileSync(cfgPath, original.replace(/"agent_folder"[^,}]*,?/, ""));
    const { rmSync } = await import("node:fs");
    rmSync(cfgPath);
    const created = await runSelftest(["02"], fresh.appDir, fresh.env);
    expect(existsSync(cfgPath)).toBe(true);
    expect(byCheck(created.results as ResultsDocument, "02")["agent-config.json"]).toBe("pass");
  }, 60000);

  test("HERAV1STST-IP01-TC-19..23 live categories in scripted mode with a reduced registry: 04 sweeps every testable model, 05 the cheapest per method x levels, 06 two turns with read_file, 08 four roles on two models; script error fails one level; timeout fails with the duration", async () => {
    const { appDir, env } = rig();
    // reduced registry: 3 models, 2 methods
    const registryPath = join(appDir, ".agent-data", "config", "model-registry.json");
    const full = JSON.parse(readFileSync(registryPath, "utf8")) as { models: Array<{ model_id: string }>; model_id_startswith: unknown[] };
    const keep = new Set(["glm-5.2", "gpt-4.1-mini", "gpt-5.6-terra"]);
    writeFileSync(registryPath, JSON.stringify({ ...full, models: full.models.filter((m) => keep.has(m.model_id)) }, null, 2));
    // script: 04 (3 models) → 3 text lines; 05: cheapest per method (temperature: gpt-4.1-mini x3 levels, reasoning_effort: gpt-5.6-terra x N, thinking: glm-5.2 x3) → text lines, one error;
    // 06: per provider (openai, zai) → tool_call + text each; 08: roles glm-5.2 high + gpt-4.1-mini low → 2 text lines
    const line = (text: string): string => JSON.stringify({ text, usage: { input_tokens: 30, output_tokens: 5 } });
    const tool = JSON.stringify({ text: "", tool_calls: [{ name: "read_file", args: { file_path: "E:/selftest/README.md" } }], usage: { input_tokens: 40, output_tokens: 8 } });
    // the matrix size follows the shipped registry: cheapest model per method x its levels (computed with the discovery module itself)
    const reduced = JSON.parse(readFileSync(registryPath, "utf8")) as ModelRegistry;
    const mapping = JSON.parse(readFileSync(join(appDir, ".agent-data", "config", "model-parameter-mapping.json"), "utf8")) as ParameterMapping;
    const pricingFile = JSON.parse(readFileSync(join(appDir, ".agent-data", "config", "model-pricing.json"), "utf8")) as { pricing: PricingTable };
    const discovered = testableModels(reduced, mapping, pricingFile.pricing, new Set(["openai", "zai"]));
    const matrixCount = [...cheapestPerMethod(discovered.testable).values()].reduce((n, m) => n + m.levels.length, 0);
    expect(matrixCount).toBeGreaterThanOrEqual(4);
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) lines.push(line("SELFTEST OK"));
    for (let i = 0; i < matrixCount; i++) lines.push(i === 1 ? JSON.stringify({ error: "level rejected (400)" }) : line("SELFTEST OK"));
    for (let i = 0; i < 2; i++) lines.push(tool, line("SELFTEST OK"));
    // 08: the scripted adapter keeps one queue per role - the generating call reads the default queue, the shared gpt-4.1-mini call runs as role compacting
    lines.push(line("SELFTEST OK"), JSON.stringify({ role: "compacting", text: "SELFTEST OK", usage: { input_tokens: 29, output_tokens: 5 } }));
    const script = join(appDir, "live-script.jsonl");
    writeFileSync(script, `${lines.join("\n")}\n`);
    const run = await runSelftest(["live", "--budget", "1"], appDir, { ...env, HERA_SCRIPTED_ADAPTER: script });
    const r = run.results as ResultsDocument;
    expect(r.categories_run).toEqual(["04", "05", "06", "08"]);
    const c04 = r.tests.filter((t) => t.category === "04");
    expect(c04.map((t) => t.model_id).sort()).toEqual(["glm-5.2", "gpt-4.1-mini", "gpt-5.6-terra"]);
    expect(c04.every((t) => t.status === "pass")).toBe(true);
    expect(c04[0]?.usage).toEqual({ uncached_input: 30, cache_write: 0, cache_read: 0, output: 5 });
    const c05 = r.tests.filter((t) => t.category === "05");
    expect(c05.length).toBe(matrixCount);
    expect(c05.filter((t) => t.status === "fail")).toHaveLength(1);
    expect(c05.find((t) => t.status === "fail")?.error_message).toContain("level rejected");
    const c06 = r.tests.filter((t) => t.category === "06");
    expect(c06.map((t) => t.provider).sort()).toEqual(["openai", "zai"]);
    expect(c06.every((t) => t.status === "pass")).toBe(true);
    expect(c06[0]?.usage?.uncached_input).toBe(70); // both turns summed
    const c08 = r.tests.filter((t) => t.category === "08");
    expect(c08.map((t) => t.check).sort()).toEqual(["compacting", "generating", "memory", "supervisor", "websearch"].sort());
    expect(c08.filter((t) => t.usage !== undefined)).toHaveLength(2); // two distinct models → two round trips
    expect(run.out).toMatch(/\[ 1 \/ 2 \] generating glm-5\.2 \(\w+, high\)/);
    expect(run.out).toMatch(/compacting, supervisor, memory(, websearch)? gpt-4\.1-mini \(temperature, low\)/);
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(run.code).toBe(1); // the one rejected level
    // timeout: a slow script line against --timeout 1
    const slow = rig({ script: "script_slow.jsonl" });
    writeFileSync(join(slow.appDir, "slow.jsonl"), `${JSON.stringify({ text: "late", delay_ms: 2500 })}\n`);
    const timed = await runSelftest(["08", "--timeout", "1"], slow.appDir, { ...slow.env, HERA_SCRIPTED_ADAPTER: join(slow.appDir, "slow.jsonl") });
    const first = (timed.results as ResultsDocument).tests.find((t) => t.category === "08");
    expect(first?.status).toBe("fail");
    expect(first?.error_message).toContain("timeout after 1 s");
    expect(first?.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(first?.duration_seconds).toBeLessThan(2.5);
  }, 90000);

  test("HERAV1STST-IP01-TC-04 budget: --budget 0 marks every live test budget_exceeded, exit 0; no key outside scripted mode → skip", async () => {
    const { appDir, env } = rig();
    const script = join(appDir, "live-script.jsonl");
    writeFileSync(script, `${JSON.stringify({ text: "SELFTEST OK" })}\n`);
    const run = await runSelftest(["08", "--budget", "0"], appDir, { ...env, HERA_SCRIPTED_ADAPTER: script });
    const r = run.results as ResultsDocument;
    expect(r.tests.every((t) => t.status === "budget_exceeded")).toBe(true);
    expect(run.code).toBe(0);
    expect(run.out).toContain("BUDGET: $0.0000 of $0.0000 left - not started");
  }, 30000);

  test("HERAV1STST-IP01-TC-27 interrupt: Ctrl+C during a category writes results.json with the completed tests and summary.interrupted", async () => {
    const { appDir, env } = rig();
    let fire: (() => void) | undefined;
    const run = await runSelftest(["01", "02"], appDir, env, (h) => {
      fire = h;
      // fire after the first category started
      setTimeout(() => fire?.(), 50);
    });
    const r = run.results as ResultsDocument;
    expect(r.summary.interrupted).toBe(true);
    expect(run.out).toContain("INTERRUPTED");
    expect(r.categories_run.length).toBeGreaterThanOrEqual(1);
    expect(readdirSync(join(appDir, ".agent-data", "selftest")).length).toBe(1);
  }, 30000);
});
