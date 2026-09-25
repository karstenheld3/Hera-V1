import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type SpawnOptions } from "../../src/harness/spawn.ts";
import { KEY_VARS } from "../../src/config/keys.ts";

const procs: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) {
    try { if (!p.killed) p.kill(); } catch {}
  }
});

/** Spawns a child that prints its environment variables to stdout for inspection. */
function spawnEnvProbe(opts: SpawnOptions): { proc: ReturnType<typeof Bun.spawn>; getEnv: () => Promise<Record<string, string>> } {
  const proc = spawn(
    process.platform === "win32"
      ? ["pwsh", "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem Env: | ForEach-Object { \"$($_.Name)=$($_.Value)\" }"]
      : ["sh", "-c", "env"],
    opts,
  );
  procs.push(proc);
  return {
    proc,
    getEnv: async () => {
      const text = await new Response(proc.stdout as ReadableStream).text();
      const env: Record<string, string> = {};
      for (const line of text.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      return env;
    },
  };
}

describe("harness_spawn: spawn boundary wrapper (FR-10, H-10)", () => {
  test("tool descendant environment has no provider key variables", async () => {
    const testKey = "test-key-value-1234567890";
    const env: Record<string, string | undefined> = {};
    for (const v of Object.values(KEY_VARS)) env[v] = testKey;
    const { proc, getEnv } = spawnEnvProbe({ kind: "tool", env, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(code).toBe(0);
    const childEnv = await getEnv();
    for (const v of Object.values(KEY_VARS)) {
      expect(childEnv[v]).toBeUndefined();
    }
  }, 10000);

  test("trusted child keeps provider key variables in environment", async () => {
    const testKey = "test-key-value-1234567890";
    const env: Record<string, string | undefined> = {};
    for (const v of Object.values(KEY_VARS)) env[v] = testKey;
    const { proc, getEnv } = spawnEnvProbe({ kind: "trusted", env, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(code).toBe(0);
    const childEnv = await getEnv();
    for (const v of Object.values(KEY_VARS)) {
      expect(childEnv[v]).toBe(testKey);
    }
  }, 10000);

  test("tool descendant keeps non-provider environment variables", async () => {
    const env: Record<string, string | undefined> = { MY_CUSTOM_VAR: "hello", PAGER: "cat" };
    const { proc, getEnv } = spawnEnvProbe({ kind: "tool", env, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(code).toBe(0);
    const childEnv = await getEnv();
    expect(childEnv["MY_CUSTOM_VAR"]).toBe("hello");
    expect(childEnv["PAGER"]).toBe("cat");
  }, 10000);
});
