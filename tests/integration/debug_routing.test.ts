import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DebugLine } from "../../src/debug/debuglog.ts";
import { assertNoSecretLeak } from "../harness/assertions.ts";
import { FAKE_SYSTEM, SCRIPTS, prepareRig } from "../harness/executor_rig.ts";
import { HeraProc } from "../harness/hera_proc.ts";
import { removeDir } from "../harness/procs.ts";

const DECOY = "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789";
const expected = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "debug", "expected_ops.json"), "utf8")) as { scripted_tool_turn: Record<string, string[]>; never: string[]; field_sets: Record<string, string[]> };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function rig(script: string, extraEnv: Record<string, string> = {}): { proc: HeraProc; appDir: string; workspace: string; logDir: string } {
  const prepared = prepareRig({ script: join(SCRIPTS, script), agentFolder: FAKE_SYSTEM, configOverrides: { supervisor: { review_every_calls: 50, cost_alert_usd: 100 } } });
  dirs.push(...prepared.dirs);
  const logDir = join(prepared.appDir, "logs");
  // the rig sets HERA_DEBUG_LINES for FakeComm-driven children; the real Communicator decides that itself (TC-13)
  const env: Record<string, string> = { HERA_DECOY_KEY: DECOY, ...extraEnv };
  const proc = new HeraProc({ workspace: prepared.workspace, appDir: prepared.appDir, scriptPath: prepared.env["HERA_SCRIPTED_ADAPTER"] as string, env });
  return { proc, appDir: prepared.appDir, workspace: prepared.workspace, logDir };
}

function readLog(logDir: string): DebugLine[] {
  const files = readdirSync(logDir).filter((f) => f.startsWith("hera-debug-") && f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return readFileSync(join(logDir, files[0] as string), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as DebugLine);
}

describe("[integration] HERAV1DEBG-TP01 routing and coverage (real three processes, --log-dir)", () => {
  test("HERAV1DEBG-IP01-TC-12/17 --log-dir only: lines from comm, exec, and sup; every expected dom/op of a scripted tool turn present with its field set", async () => {
    const { proc, logDir } = rig("script_exec_basic.jsonl");
    const result = await proc.run(["--log-dir", logDir, "-p", "read the readme", "--output-format", "jsonl"], { timeoutMs: 60000 });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Debug log: ");
    const lines = readLog(logDir);
    const procs = new Set(lines.map((l) => l.proc));
    expect([...procs].sort()).toEqual(["comm", "exec", "sup"]);
    const ops = new Set(lines.map((l) => `${l.proc}:${l.dom} ${l.op}`));
    for (const [procName, list] of Object.entries(expected.scripted_tool_turn)) for (const op of list) expect(ops.has(`${procName}:${op}`)).toBe(true);
    for (const [key, fields] of Object.entries(expected.field_sets)) {
      const [dom, op] = key.split(" ");
      const sample = lines.find((l) => l.dom === dom && l.op === op);
      expect(sample).toBeDefined();
      for (const f of fields) expect(sample !== undefined && f in sample).toBe(true);
    }
    // every line has the four mandatory keys and a full-date timestamp
    for (const l of lines) {
      expect(l.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      expect(typeof l.dom).toBe("string");
      expect(typeof l.op).toBe("string");
    }
    // stdout stayed pure JSONL events (the debug lines never touch stdout)
    for (const line of result.stdout.trim().split(/\r?\n/)) expect((JSON.parse(line) as { type: string }).type).toBeDefined();
  }, 90000);

  test("HERAV1DEBG-IP01-TC-18/21 no per-delta, heartbeat, or relay lines; privacy: no prompt text, tool result, or key in the log", async () => {
    const { proc, logDir } = rig("script_exec_basic.jsonl");
    const result = await proc.run(["--log-dir", logDir, "-p", "read the readme PRIVATE_PROMPT_MARKER", "--output-format", "jsonl"], { timeoutMs: 60000 });
    expect(result.code).toBe(0);
    const lines = readLog(logDir);
    for (const never of expected.never) expect(lines.some((l) => l.op === never || l.dom === never)).toBe(false);
    const text = readFileSync(join(logDir, readdirSync(logDir)[0] as string), "utf8");
    expect(text).not.toContain("PRIVATE_PROMPT_MARKER");
    expect(text).not.toContain("Hello from the rig"); // README content = tool result
    expect(text).not.toContain("Reading the README"); // assistant text
    assertNoSecretLeak([text], undefined, [DECOY]);
  }, 90000);

  test("HERAV1DEBG-IP01-TC-13 HERA_DEBUG_LINES: set in children only when a sink is active; a stale parent value is cleared otherwise", async () => {
    const stale = rig("script_exec_basic.jsonl", { HERA_DEBUG_LINES: "1" });
    let off: { code: number | null } = { code: 1 };
    for (let attempt = 0; attempt < 3 && off.code !== 0; attempt++) {
      off = await stale.proc.runWithRetry(["-p", "read the readme", "--output-format", "jsonl"], { timeoutMs: 60000 });
    }
    expect(off.code).toBe(0);
    expect(existsSync(stale.logDir)).toBe(false);
    // the Executor would have sent debug_line messages if the variable had leaked; the Communicator forwards none without a sink,
    // so the only observable is the absence of any debug artifact - confirmed by a second run WITH the sink where exec lines appear
    const on = rig("script_exec_basic.jsonl");
    mkdirSync(on.logDir, { recursive: true });
    let res: { code: number | null } = { code: 1 };
    for (let attempt = 0; attempt < 3 && res.code !== 0; attempt++) {
      res = await on.proc.runWithRetry(["--log-dir", on.logDir, "-p", "read the readme", "--output-format", "jsonl"], { timeoutMs: 60000 });
    }
    expect(res.code).toBe(0);
    expect(readLog(on.logDir).some((l) => l.proc === "exec")).toBe(true);
  }, 120000);

  test("HERAV1DEBG-IP01-TC-14/20 Executor restart mid-turn: ipc exit, ipc restart, turn_summary {aborted: true}, the new child logs again", async () => {
    const { proc, logDir } = rig("script_sleep_short.jsonl");
    const handle = proc.startPiped(["--log-dir", logDir]);
    handle.send("run it");
    // wait for the tool to start, then kill the Executor from the outside
    const deadline = performance.now() + 40000;
    let execPid: number | undefined;
    while (execPid === undefined && performance.now() < deadline) {
      await Bun.sleep(200);
      if (!existsSync(logDir)) continue;
      const files = readdirSync(logDir);
      if (files.length === 0) continue;
      const lines = readFileSync(join(logDir, files[0] as string), "utf8").trim().split("\n").map((l) => JSON.parse(l) as DebugLine);
      if (lines.some((l) => l.proc === "exec" && l.op === "start")) execPid = (lines.find((l) => l.op === "hello" && l["role"] === "executor") as { pid?: number } | undefined)?.pid;
    }
    expect(execPid).toBeDefined();
    process.kill(execPid as number, "SIGKILL");
    await Bun.sleep(6000);
    handle.send("/exit");
    const code = await handle.waitExit(20000);
    expect(code).toBe(0);
    const lines = readLog(logDir);
    expect(lines.some((l) => l.dom === "ipc" && l.op === "exit" && l["role"] === "executor")).toBe(true);
    expect(lines.some((l) => l.dom === "ipc" && l.op === "restart" && l["role"] === "executor")).toBe(true);
    expect(lines.some((l) => l.dom === "ipc" && l.op === "turn_summary" && l["aborted"] === true)).toBe(true);
    const hellos = lines.filter((l) => l.op === "hello" && l["role"] === "executor");
    expect(hellos.length).toBe(2);
    const secondEpochLines = lines.filter((l) => l.proc === "exec" && l.op === "response");
    expect(secondEpochLines.length).toBeGreaterThanOrEqual(1);
    rmSync(logDir, { recursive: true, force: true });
  }, 90000);
});
