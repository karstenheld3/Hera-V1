import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertEventOrder, assertNoSecretLeak } from "../harness/assertions.ts";
import { FakeComm } from "../harness/fake_comm.ts";
import { hasKey } from "../harness/live.ts";
import { makeTempDir, removeDir } from "../harness/procs.ts";
import type { AgentEvent } from "../../src/events.ts";

const comms: FakeComm[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of comms.splice(0)) await c.shutdown(500);
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("HERAV1AGNT-TP01 harness", () => {
  test("HERAV1AGNT-TP01-TC-13 FakeComm spawns the real Executor role, receives hello, and records a clean shutdown", async () => {
    const comm = new FakeComm();
    comms.push(comm);
    await comm.spawn("executor", 1);
    const hello = await comm.waitFor((m) => m.type === "hello", 15000, "hello");
    expect(hello.type === "hello" && hello.payload.role).toBe("executor");
    const code = await comm.shutdown(5000);
    expect(code).toBe(0);
  });
  test("HERAV1AGNT-TP01-TC-15 hasKey is false with no environment and no key file", () => {
    const dir = makeTempDir("nokeys");
    dirs.push(dir);
    const missing = join(dir, "absent.txt");
    for (const p of ["openai", "anthropic", "zai"] as const) expect(hasKey(p, {}, missing)).toBe(false);
    const env = { OPENAI_API_KEY: "HERA_DECOY_abcdefgh12345678" };
    expect(hasKey("openai", env, missing)).toBe(true);
    expect(hasKey("zai", env, missing)).toBe(false);
  });

  test("hasKey reads presence from a key file without exposing values", async () => {
    const dir = makeTempDir("keyfile");
    dirs.push(dir);
    const file = join(dir, "keys.txt");
    await Bun.write(file, "# comment\nOPENAI_API_KEY=\nZAI_API_KEY=HERA_DECOY_zzzzzzzz00000000\n");
    expect(hasKey("openai", {}, file)).toBe(false);
    expect(hasKey("zai", {}, file)).toBe(true);
    expect(hasKey("anthropic", {}, file)).toBe(false);
  });

  test("assertions: event order subsequence and secret leak detection", () => {
    const events = [
      { ts: "t", proc: "exec", type: "turn_started", role: "generating" },
      { ts: "t", proc: "exec", type: "text_delta", text: "x" },
      { ts: "t", proc: "exec", type: "turn_finished", role: "generating", uncached_input: 0, cache_write: 0, cache_read: 0, output: 0 },
    ] as AgentEvent[];
    assertEventOrder(events, ["turn_started", "turn_finished"]);
    expect(() => assertEventOrder(events, ["turn_finished", "turn_started"])).toThrow();
    assertNoSecretLeak(["Keys: OpenAI (Environment variable: OPENAI_API_KEY)"]);
    expect(() => assertNoSecretLeak(["token HERA_DECOY_abcdefgh12345678 here"])).toThrow(/leaked/);
    expect(() => assertNoSecretLeak(["value"], [], ["value"])).toThrow(/leaked/);
  });
});
