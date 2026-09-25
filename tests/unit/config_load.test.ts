import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAppDir, resolveUnderAppDir } from "../../src/config/appdir.ts";
import { KEY_FILE_TEMPLATE, KeyHandle, fileSourceWarning, keySourceLine, parseKeyFile, resolveKey } from "../../src/config/keys.ts";
import { ROLE_SETS, loadConfig, rolesSummary } from "../../src/config/load.ts";
import { ConfigError } from "../../src/errors.ts";
import { assertNoSecretLeak } from "../harness/assertions.ts";
import { readBytes, tempAppDir, testEnv, writeConfig } from "../harness/config_fixtures.ts";
import { REPO_ROOT, removeDir } from "../harness/procs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const DECOY = "HERA_DECOY_abcdefgh12345678";
const scriptedLoad = (appDir: string, configPath?: string) => loadConfig({ appDir, configPath, roles: "all", requireKeys: true, scripted: true, env: testEnv() });

describe("HERAV1PRCF-TP01 loading and resolution", () => {
  test("HERAV1PRCF-TP01-TC-08 default path missing → created with a Created line; explicit path missing → ConfigError", () => {
    const { appDir, configPath } = tempAppDir("none");
    dirs.push(appDir);
    const resolved = scriptedLoad(appDir);
    expect(existsSync(configPath)).toBe(true);
    expect(resolved.created).toEqual([configPath]);
    expect(resolved.notices.some((n) => n.startsWith("Created "))).toBe(true);
    expect(resolved.roles.generating.modelId).toBe("glm-5.2");
    expect(() => loadConfig({ appDir, configPath: join(appDir, "elsewhere.json"), roles: "all", requireKeys: false, scripted: true })).toThrow(ConfigError);
    expect(existsSync(join(appDir, "elsewhere.json"))).toBe(false);
  });

  test("the user's V1-shaped config loads with the migration notice and the file untouched", () => {
    const { appDir, configPath } = tempAppDir("v1_user_shape");
    dirs.push(appDir);
    const before = readBytes(configPath);
    const resolved = scriptedLoad(appDir);
    expect(resolved.migrated).toBe(true);
    expect(resolved.notices.filter((n) => n.includes("V1-shaped"))).toHaveLength(1);
    expect(resolved.roles.generating.modelId).toBe("glm-5.2");
    expect(resolved.roles.generating.provider).toBe("zai");
    expect(resolved.roles.compacting.modelId).toBe("gpt-4.1-mini");
    expect(resolved.roles.websearch.aliasOf).toBeUndefined();
    expect(resolved.config.supervisor.denylist).toHaveLength(13);
    expect(readBytes(configPath)).toBe(before);
    expect(rolesSummary(resolved)).toBe("generating: glm-5.2 (high) | compacting: gpt-4.1-mini (low) | supervisor: gpt-4.1-mini (low) | memory: gpt-4.1-mini (low)");
  });

  test("HERAV1PRCF-TP01-TC-09 disabled, unknown, and prefix-less models fail naming role, model, action", () => {
    const { appDir, configPath } = tempAppDir("v2_minimal");
    dirs.push(appDir);
    const attempt = (modelId: string): string => {
      writeConfig(configPath, { roles: { generating: { model_id: modelId, effort: "high" } } });
      try {
        scriptedLoad(appDir);
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    const disabled = attempt("gpt-6-astra");
    expect(disabled).toContain("roles.generating");
    expect(disabled).toContain("gpt-6-astra");
    expect(disabled).toMatch(/disabled|Enable/);
    const unknown = attempt("gpt-9");
    expect(unknown).toContain("gpt-9");
    expect(unknown).toContain("not in model-registry.json");
    const registryPath = join(appDir, ".agent-data", "config", "model-registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { models: Array<Record<string, unknown>> };
    registry.models.push({ provider: "openai", model_id: "mystery-1", name: "Mystery", enabled: true, status: "available" });
    writeFileSync(registryPath, JSON.stringify(registry));
    const noPrefix = attempt("mystery-1");
    expect(noPrefix).toContain("matches no model_id_startswith prefix");
  });

  test("HERAV1PRCF-TP01-TC-10 invalid effort level lists the allowed levels", () => {
    const { appDir, configPath } = tempAppDir("v2_minimal");
    dirs.push(appDir);
    writeConfig(configPath, { roles: { generating: { model_id: "gpt-4.1-mini", effort: "xhigh" } } });
    let message = "";
    try {
      scriptedLoad(appDir);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("xhigh");
    expect(message).toContain("low, medium, high");
    writeConfig(configPath, { roles: { generating: { model_id: "glm-5.3", effort: "medium" } } });
    let message2 = "";
    try {
      scriptedLoad(appDir);
    } catch (e) {
      message2 = (e as Error).message;
    }
    expect(message2).toContain("low, high, max");
  });

  /** The shipped registry enables no adaptive_thinking/effort model; the temp registry adds test entries for those two methods. */
  const enableTestModels = (appDir: string): void => {
    const registryPath = join(appDir, ".agent-data", "config", "model-registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { models: Array<Record<string, unknown>> };
    registry.models.push({ provider: "anthropic", model_id: "claude-sonnet-5-test", enabled: true, status: "available", context_window: 1000000 });
    registry.models.push({ provider: "anthropic", model_id: "claude-opus-4.5-test", enabled: true, status: "available", context_window: 200000 });
    writeFileSync(registryPath, JSON.stringify(registry));
  };

  test("HERAV1PRCF-TP01-TC-14 the five methods translate to their neutral parameter shapes", () => {
    const { appDir, configPath } = tempAppDir("v2_minimal");
    dirs.push(appDir);
    enableTestModels(appDir);
    writeConfig(configPath, {
      roles: {
        generating: { model_id: "gpt-4.1-mini", effort: "medium" },
        compacting: { model_id: "gpt-5.6-sol", effort: "high" },
        supervisor: { model_id: "claude-sonnet-4-5-20250929", effort: "medium" },
        memory: { model_id: "claude-sonnet-5-test", effort: "high" },
        websearch: { model_id: "claude-opus-4.5-test", effort: "low" },
      },
    });
    const r = scriptedLoad(appDir);
    expect(r.roles.generating.params).toEqual({ method: "temperature", temperature: 0.7 });
    expect(r.roles.compacting.params).toEqual({ method: "reasoning_effort", reasoning_effort: "high" });
    expect(r.roles.supervisor.method).toBe("thinking");
    expect(r.roles.supervisor.params).toEqual({ method: "thinking", thinking_budget: 10000 });
    expect(r.roles.memory.params).toEqual({ method: "adaptive_thinking", effort: "high" });
    expect(r.roles.websearch.params).toEqual({ method: "effort", effort: "low", beta: "effort-2025-11-24" });
    expect(r.roles.websearch.maxOutput).toBe(8192);
    expect(r.roles.compacting.maxInput).toBe(1050000);
  });

  test("HERAV1PRCF-TP01-TC-11 missing key names the variable and both sources, never a value; scripted mode skips keys", () => {
    const { appDir } = tempAppDir("v2_minimal");
    dirs.push(appDir);
    let message = "";
    try {
      loadConfig({ appDir, roles: ["generating"], requireKeys: true, scripted: false, env: testEnv({ OPENAI_API_KEY: DECOY }) });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("ZAI_API_KEY");
    expect(message).toContain("environment");
    expect(message).toContain(".api-keys.txt");
    assertNoSecretLeak([message], undefined, [DECOY]);
    const scripted = loadConfig({ appDir, roles: ["generating"], requireKeys: true, scripted: true, env: testEnv() });
    expect(Object.keys(scripted.keys)).toHaveLength(0);
  });

  test("HERAV1PRCF-TP01-TC-12 malformed key file: values parsed, quotes stripped, one WARNING with the line number and no content", () => {
    const text = readFileSync(join(REPO_ROOT, "tests", "fixtures", "keys", "keys_malformed.txt"), "utf8");
    const parsed = parseKeyFile(text, ".api-keys.txt");
    expect(parsed.entries["OPENAI_API_KEY"]).toBe("HERA_DECOY_openai0000000001");
    expect(parsed.entries["ANTHROPIC_API_KEY"]).toBe("HERA_DECOY_anthropic00000001");
    expect(parsed.entries["ZAI_API_KEY"]).toBeUndefined();
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("WARNING:");
    expect(parsed.warnings[0]).toContain("line 4");
    expect(parsed.warnings[0]).not.toContain("equals sign");
    assertNoSecretLeak(parsed.warnings);
    const handle = resolveKey("openai", {}, parsed.entries);
    expect(handle).toBeInstanceOf(KeyHandle);
    expect(handle?.source).toBe("file");
    expect(JSON.stringify(handle)).not.toContain("HERA_DECOY");
    expect(String(handle)).not.toContain("HERA_DECOY");
    expect(handle?.reveal()).toBe("HERA_DECOY_openai0000000001");
    expect(resolveKey("openai", { OPENAI_API_KEY: "HERA_DECOY_envvalue000000001" }, parsed.entries)?.source).toBe("env");
    expect(KEY_FILE_TEMPLATE).toContain("# OPENAI_API_KEY=");
    expect(keySourceLine([new KeyHandle("zai", "env", "x"), new KeyHandle("openai", "file", "y")])).toBe("Keys: Z.ai (Environment variable: ZAI_API_KEY), OpenAI (.agent-data\\config\\.api-keys.txt: OPENAI_API_KEY)");
  });

  test("HERAV1PRCF-TP01-TC-13 per-process role sets resolve only their providers' keys", () => {
    const { appDir, configPath } = tempAppDir("v2_minimal");
    dirs.push(appDir);
    writeConfig(configPath, { roles: { generating: { model_id: "glm-5.2", effort: "high" }, supervisor: { model_id: "claude-sonnet-4-5-20250929", effort: "low" } } });
    const env = testEnv({ OPENAI_API_KEY: DECOY, ANTHROPIC_API_KEY: DECOY, ZAI_API_KEY: DECOY });
    const seen: string[] = [];
    const comm = loadConfig({ appDir, roles: ROLE_SETS.communicator, requireKeys: true, scripted: false, env, onResolveKey: (p) => seen.push(p) });
    expect(seen).toEqual([]);
    expect(Object.keys(comm.keys)).toEqual([]);
    seen.length = 0;
    loadConfig({ appDir, roles: ROLE_SETS.supervisor, requireKeys: true, scripted: false, env, onResolveKey: (p) => seen.push(p) });
    expect(seen.sort()).toEqual(["anthropic", "openai"]);
    seen.length = 0;
    const all = loadConfig({ appDir, roles: "all", requireKeys: true, scripted: false, env, onResolveKey: (p) => seen.push(p) });
    expect(seen.sort()).toEqual(["anthropic", "openai", "zai"]);
    expect(Object.keys(all.roles).sort()).toEqual(["compacting", "generating", "memory", "supervisor", "websearch"]);
  });

  test("HERAV1PRCF-TP01-TC-15 websearch alias absent → compacting; present → own resolution", () => {
    const { appDir, configPath } = tempAppDir("v2_minimal");
    dirs.push(appDir);
    const absent = scriptedLoad(appDir);
    expect(absent.roles.websearch.aliasOf).toBe("compacting");
    expect(absent.roles.websearch.modelId).toBe(absent.roles.compacting.modelId);
    writeConfig(configPath, { roles: { generating: { model_id: "glm-5.2", effort: "high" }, websearch: { model_id: "gpt-5.6-sol", effort: "low" } } });
    const present = scriptedLoad(appDir);
    expect(present.roles.websearch.aliasOf).toBeUndefined();
    expect(present.roles.websearch.modelId).toBe("gpt-5.6-sol");
  });
});

describe("HERAV1PRCF-TP01 app directory", () => {
  test("HERAV1PRCF-TP01-TC-16 flag beats env beats default", () => {
    expect(resolveAppDir({ flag: "C:/flag", env: "C:/env", cwd: "C:/cwd", standalone: false })).toBe(resolveAppDir({ flag: "C:/flag", cwd: "C:/x", standalone: false }));
    expect(resolveAppDir({ env: "C:/env", cwd: "C:/cwd", standalone: false })).toBe(resolveAppDir({ flag: "C:/env", cwd: "C:/x", standalone: false }));
    expect(resolveAppDir({ cwd: "C:/cwd", standalone: false })).toBe(resolveAppDir({ flag: "C:/cwd", cwd: "C:/x", standalone: false }));
  });

  test("HERAV1PRCF-TP01-TC-17 bun run → CWD; standalone → parent of the binary", () => {
    expect(resolveAppDir({ cwd: REPO_ROOT, standalone: false, execPath: "C:/tools/hera/hera.exe" })).toBe(REPO_ROOT);
    const standalone = resolveAppDir({ cwd: REPO_ROOT, standalone: true, execPath: "C:/tools/hera/hera.exe" });
    expect(standalone.replace(/\\/g, "/")).toBe("C:/tools/hera");
  });

  test("HERAV1PRCF-TP01-TC-18 relative --app-dir resolves under CWD; relative agent_folder resolves under the app dir", () => {
    const appDir = resolveAppDir({ flag: "./x", cwd: REPO_ROOT, standalone: false });
    expect(appDir).toBe(join(REPO_ROOT, "x"));
    expect(resolveUnderAppDir(appDir, ".agent")).toBe(join(REPO_ROOT, "x", ".agent"));
    expect(resolveUnderAppDir(appDir, "C:/abs/agent").replace(/\\/g, "/")).toBe("C:/abs/agent");
  });
});

describe("HERAV1PRCF-TP01 U11 credential hardening", () => {
  test("HERAV1PRCF-TP01-TC-37 keys.allow_file=false ignores key file; missing-key error names only the variable", () => {
    const { appDir, configPath } = tempAppDir("v2_minimal");
    dirs.push(appDir);
    writeConfig(configPath, { roles: { generating: { model_id: "glm-5.2", effort: "high" } }, keys: { allow_file: false } });
    const env = testEnv();
    delete env["ZAI_API_KEY"];
    delete env["OPENAI_API_KEY"];
    delete env["ANTHROPIC_API_KEY"];
    expect(() => loadConfig({ appDir, roles: "all", requireKeys: true, scripted: false, env })).toThrow(/ZAI_API_KEY not found in the environment\./);
    expect(() => loadConfig({ appDir, roles: "all", requireKeys: true, scripted: false, env })).not.toThrow(/api-keys/);
  });

  test("HERAV1PRCF-TP01-TC-37b keys.allow_file=true (default) with file-sourced key → WARNING; env-sourced → no WARNING", () => {
    const { appDir, configPath } = tempAppDir("v2_minimal");
    dirs.push(appDir);
    writeConfig(configPath, { roles: { generating: { model_id: "glm-5.2", effort: "high" } } });
    const keyPath = join(appDir, ".agent-data", "config", ".api-keys.txt");
    writeFileSync(keyPath, `ZAI_API_KEY=${DECOY}\nOPENAI_API_KEY=${DECOY}\n`);
    const env = testEnv();
    delete env["ZAI_API_KEY"];
    delete env["OPENAI_API_KEY"];
    const resolved = loadConfig({ appDir, roles: "all", requireKeys: true, scripted: false, env });
    const handles = Object.values(resolved.keys);
    const warn = fileSourceWarning(handles);
    expect(warn).toBeDefined();
    expect(warn).toContain("2 key(s) loaded from .api-keys.txt");
    const envHandles = handles.map((h) => new KeyHandle(h.provider, "env", h.reveal()));
    expect(fileSourceWarning(envHandles)).toBeUndefined();
  });
});
