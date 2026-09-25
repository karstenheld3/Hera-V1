import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_NOTICE, detectMixed, detectRemovedKeys, isV1Shaped, migrateV1 } from "../../src/config/migrate.ts";
import { parseHeraConfig } from "../../src/config/schema.ts";
import { ConfigError } from "../../src/errors.ts";
import { REPO_ROOT } from "../harness/procs.ts";

const fixture = (name: string): { raw: Record<string, unknown>; bytes: string } => {
  const path = join(REPO_ROOT, "tests", "fixtures", "configs", `${name}.json`);
  const bytes = readFileSync(path, "utf8");
  return { raw: JSON.parse(bytes) as Record<string, unknown>, bytes };
};

describe("HERAV1PRCF-TP01 migration", () => {
  test("HERAV1PRCF-TP01-TC-04 the user's V1-shaped file migrates in memory with the FR-02 notice; file bytes unchanged", () => {
    const { raw, bytes } = fixture("v1_user_shape");
    expect(isV1Shaped(raw)).toBe(true);
    const { config: migratedRaw, notice } = migrateV1(raw);
    expect(notice).toBe(MIGRATION_NOTICE);
    expect(notice).toBe(
      "NOTICE: agent-config.json is V1-shaped -> migrated in memory (generator -> generating, summarizer -> compacting, execution_policy dropped, command_denylist -> supervisor.denylist). Hera V1 runs in Turbo mode; the file was not modified.",
    );
    const { config } = parseHeraConfig(migratedRaw, "agent-config.json");
    expect(config.roles.generating).toEqual({ model_id: "glm-5.2", effort: "high" });
    expect(config.roles.compacting).toEqual({ model_id: "gpt-4.1-mini", effort: "low" });
    expect(config.roles.websearch).toEqual({ model_id: "gpt-4.1-mini", effort: "low" });
    expect(config.roles.supervisor).toEqual({ model_id: "gpt-4.1-mini", effort: "low" });
    expect(config.roles.memory).toEqual({ model_id: "gpt-4.1-mini", effort: "low" });
    expect(config.max_tool_calls_per_prompt).toBe(25);
    expect(config.supervisor.denylist).toEqual(raw["command_denylist"] as string[]);
    expect(config.supervisor.stall_timeout_s).toBe(120);
    expect(config.ipc.heartbeat_s).toBe(5);
    expect("execution_policy" in migratedRaw).toBe(false);
    expect("command_denylist" in migratedRaw).toBe(false);
    expect(readFileSync(join(REPO_ROOT, "tests", "fixtures", "configs", "v1_user_shape.json"), "utf8")).toBe(bytes);
  });

  test("HERAV1PRCF-TP01-TC-05 V2 file with a leftover V1 key is rejected naming the key", () => {
    const { raw } = fixture("v2_mixed");
    expect(isV1Shaped(raw)).toBe(false);
    let error: unknown;
    try {
      detectMixed(raw, "agent-config.json");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("execution_policy");
    expect((error as Error).message).toContain("agent-config.json");
  });

  test("HERAV1PRCF-TP01-TC-06 V1 file with command_denylist [] keeps the empty user list (EC-16)", () => {
    const { raw } = fixture("v1_empty_denylist");
    const { config } = parseHeraConfig(migrateV1(raw).config, "x");
    expect(config.supervisor.denylist).toEqual([]);
  });

  test("V1 file without command_denylist gets the 13-entry default", () => {
    const { config } = parseHeraConfig(migrateV1({ roles: { generator: { model_id: "glm-5.2", effort: "high" } }, execution_policy: "turbo" }).config, "x");
    expect(config.supervisor.denylist).toHaveLength(13);
  });

  test("HERAV1PRCF-TP01-TC-07 unknown key names the key; broken JSON names the file", () => {
    const { raw } = fixture("v2_unknown_key");
    expect(() => parseHeraConfig(raw, "agent-config.json")).toThrow(/foo/);
  });

  test("roles.communicator in a V2 config triggers a NOTICE and is stripped", () => {
    const raw: Record<string, unknown> = { roles: { generating: { model_id: "glm-5.2", effort: "high" }, communicator: { model_id: "gpt-4.1-mini", effort: "low" } } };
    const notices: string[] = [];
    detectRemovedKeys(raw, notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("roles.communicator");
    expect(notices[0]).toContain("NOTICE");
    expect("communicator" in (raw.roles as Record<string, unknown>)).toBe(false);
  });
});
