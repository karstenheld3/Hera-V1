import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/errors.ts";
import { DEFAULT_DENYLIST, DEFAULT_PROTECTED_PATHS, DEFAULT_ROLES, parseHeraConfig, validateCompactionBound } from "../../src/config/schema.ts";

describe("HERAV1PRCF-TP01 schema", () => {
  test("HERAV1PRCF-TP01-TC-01 minimal V2 file yields every section 4 default", () => {
    const { config, notices } = parseHeraConfig({ roles: { generating: { model_id: "glm-5.2", effort: "high" } } }, "agent-config.json");
    expect(config.roles.generating).toEqual({ model_id: "glm-5.2", effort: "high" });
    expect(config.roles.compacting).toEqual({ model_id: "gpt-4.1-mini", effort: "low" });
    expect(config.roles.supervisor).toEqual({ model_id: "gpt-4.1-mini", effort: "low" });
    expect(config.roles.memory).toEqual({ model_id: "gpt-4.1-mini", effort: "low" });
    expect(config.roles.websearch).toBeUndefined();
    expect(config.agent_folder).toBe(".agent");
    expect(config.data_dir).toBe(".agent-data");
    expect(config.rule_block_max_chars).toBe(6000);
    expect(config.max_tool_calls_per_prompt).toBe(40);
    expect(config.auto_continue).toBe(false);
    expect(config.tool_result_max_chars).toBe(50000);
    expect(config.compaction_threshold_fraction).toBe(0.6);
    expect(config.compaction_threshold_max_tokens).toBe(150000);
    expect(config.workspace_tree_max_depth).toBe(4);
    expect(config.workspace_tree_max_lines).toBe(200);
    expect(config.supervisor.denylist).toEqual(["rm", "del", "rmdir", "erase", "ri", "Remove-Item", "Move-Item", "format", "kill", "pkill", "Stop-Process", "shutdown", "git push --force"]);
    expect(config.supervisor.denylist).toEqual([...DEFAULT_DENYLIST]);
    expect(config.supervisor.stall_timeout_s).toBe(120);
    expect(config.supervisor.review_every_calls).toBe(10);
    expect(config.supervisor.cost_alert_usd).toBe(1.0);
    expect(config.supervisor.memory_dir).toBe("memories");
    expect(config.supervisor.memory_top_k).toBe(5);
    expect(config.ipc).toEqual({ heartbeat_s: 5, ack_timeout_ms: 5000, hello_timeout_ms: 5000, shutdown_timeout_ms: 3000, restart_budget: 1 });
    expect(notices).toHaveLength(3);
    expect(DEFAULT_ROLES.generating.model_id).toBe("glm-5.2");
  });

  test("HERAV1PRCF-TP01-TC-02 file without roles.generating fails naming the key", () => {
    let error: unknown;
    try {
      parseHeraConfig({}, "agent-config.json");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("roles.generating");
    expect((error as Error).message).toContain("agent-config.json");
  });

  test("HERAV1PRCF-TP01-TC-03 only generating configured: three NOTICE lines, one per defaulted role", () => {
    const { notices } = parseHeraConfig({ roles: { generating: { model_id: "glm-5.2", effort: "high" } } }, "agent-config.json");
    expect(notices).toHaveLength(3);
    for (const role of ["compacting", "supervisor", "memory"]) {
      expect(notices.some((n) => n.startsWith("NOTICE:") && n.includes(`'${role}'`) && n.includes("gpt-4.1-mini (low)"))).toBe(true);
    }
    const full = parseHeraConfig({ roles: { generating: { model_id: "a", effort: "high" }, compacting: { model_id: "b", effort: "low" }, supervisor: { model_id: "c", effort: "low" }, memory: { model_id: "d", effort: "low" } } }, "x");
    expect(full.notices).toHaveLength(0);
  });

  test("HERAV1PRCF-IP01-TC-06/07 unknown top-level key rejected; ipc.restart_budget -1 rejected, 0 accepted", () => {
    expect(() => parseHeraConfig({ roles: { generating: { model_id: "a", effort: "high" } }, foo: 1 }, "x")).toThrow(/foo/);
    expect(() => parseHeraConfig({ roles: { generating: { model_id: "a", effort: "high" } }, ipc: { restart_budget: -1 } }, "x")).toThrow(ConfigError);
    expect(parseHeraConfig({ roles: { generating: { model_id: "a", effort: "high" } }, ipc: { restart_budget: 0 } }, "x").config.ipc.restart_budget).toBe(0);
    expect(() => parseHeraConfig({ roles: { generating: { model_id: "a", effort: "high" } }, supervisor: { denylist: "rm" } }, "x")).toThrow(/supervisor\.denylist/);
  });

  test("HERAV1PRCF-TP01-TC-34 validateCompactionBound: NOTICE when threshold + output + tool result exceeds max_input", () => {
    expect(validateCompactionBound(150000, 16384, 50000, 128000)).toBeDefined();
    expect(validateCompactionBound(150000, 16384, 50000, 200000)).toBeUndefined();
    expect(validateCompactionBound(120000, 16384, 50000, 200000)).toBeUndefined();
  });

  test("HERAV1PRCF-TP01-TC-35 harness.local config keys: defaults and explicit values", () => {
    // minimal V2 file -> harness.local.read_allowlist defaults to [], protected_paths defaults to DEFAULT_PROTECTED_PATHS
    const { config } = parseHeraConfig({ roles: { generating: { model_id: "glm-5.2", effort: "high" } } }, "agent-config.json");
    expect(config.harness.local.read_allowlist).toEqual([]);
    expect(config.harness.local.protected_paths).toEqual([...DEFAULT_PROTECTED_PATHS]);

    // explicit read_allowlist
    const { config: cfg2 } = parseHeraConfig({ roles: { generating: { model_id: "a", effort: "high" } }, harness: { local: { read_allowlist: ["/tmp"] } } }, "x");
    expect(cfg2.harness.local.read_allowlist).toEqual(["/tmp"]);
    expect(cfg2.harness.local.protected_paths).toEqual([...DEFAULT_PROTECTED_PATHS]);

    // explicit protected_paths
    const { config: cfg3 } = parseHeraConfig({ roles: { generating: { model_id: "a", effort: "high" } }, harness: { local: { protected_paths: ["custom"] } } }, "x");
    expect(cfg3.harness.local.protected_paths).toEqual(["custom"]);
    expect(cfg3.harness.local.read_allowlist).toEqual([]);
  });

  test("HERAV1PRCF-TP01-TC-36 harness defaults: fsync on, profile local; explicit false accepted", () => {
    const { config } = parseHeraConfig({ roles: { generating: { model_id: "glm-5.2", effort: "high" } } }, "agent-config.json");
    expect(config.harness.profile).toBe("local");
    expect(config.harness.fsync).toBe(true);
    const { config: off } = parseHeraConfig({ roles: { generating: { model_id: "a", effort: "high" } }, harness: { fsync: false } }, "x");
    expect(off.harness.fsync).toBe(false);
  });
});
