import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Communicator, type FrontendHooks } from "../../src/communicator/core.ts";
import { loadConfig } from "../../src/config/load.ts";
import { readJsonlFile, type AgentEvent } from "../../src/events.ts";
import type { PayloadOf } from "../../src/process/envelope.ts";
import { FAKE_SYSTEM, SCRIPTS, prepareRig } from "../harness/executor_rig.ts";
import { REPO_ROOT, removeDir, waitFor } from "../harness/procs.ts";

const ENTRY = join(REPO_ROOT, "src", "index.ts");
const comms: Communicator[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of comms.splice(0)) await c.shutdown("test").catch(() => undefined);
  for (const d of dirs.splice(0)) removeDir(d);
});

interface Rec extends FrontendHooks {
  events: AgentEvent[];
  notices: string[];
  asks: PayloadOf<"ask_user">[];
  turnEnds: number;
}

const recorder = (): Rec => {
  const r: Rec = { events: [], notices: [], asks: [], turnEnds: 0, onEvent: (e) => r.events.push(e), onAskUser: (a) => r.asks.push(a), onNotice: (l) => r.notices.push(l), onTurnEnd: () => r.turnEnds++ };
  return r;
};

async function threeProcesses(script: string, overrides: Record<string, unknown> = {}): Promise<{ comm: Communicator; rec: Rec; workspace: string }> {
  const prepared = prepareRig({ script: join(SCRIPTS, script), agentFolder: FAKE_SYSTEM, configOverrides: { supervisor: { review_every_calls: 50, cost_alert_usd: 100 }, ...overrides } });
  dirs.push(...prepared.dirs);
  const config = loadConfig({ appDir: prepared.appDir, roles: "all", requireKeys: false, scripted: true, env: {} });
  const rec = recorder();
  const comm = new Communicator(rec, { workspace: prepared.workspace, config, env: prepared.env, entryMain: ENTRY, helloTimeoutMs: 15000 });
  comms.push(comm);
  await comm.start();
  return { comm, rec, workspace: prepared.workspace };
}

describe("[integration] HERAV1PROC-TP01 Phase 4 - Communicator + real Executor + real Supervisor (scripted)", () => {
  test("one headless turn across three processes: session_started first, every tool_call_requested line precedes its execution, verdicts flow, turn ends", async () => {
    const { comm, rec } = await threeProcesses("script_exec_basic.jsonl");
    expect(comm.status().children.map((c) => c.state)).toEqual(["ready", "ready"]);
    comm.submitPrompt("read the readme");
    await waitFor(() => rec.turnEnds === 1, 20000, "turn end");
    const onDisk = readJsonlFile(comm.store.path).events;
    expect(onDisk[0]?.type).toBe("session_started");
    expect((onDisk[0] as { system_prompt: string }).system_prompt.startsWith("You are Hera, ")).toBe(true);
    const types = onDisk.map((e) => `${e.proc}:${e.type}`);
    expect(types).toContain("exec:tool_call_requested");
    expect(types).toContain("exec:tool_call_finished");
    expect(types.indexOf("exec:tool_call_requested")).toBeLessThan(types.indexOf("exec:tool_call_finished"));
    const finished = onDisk.find((e) => e.type === "turn_finished" && e.proc === "exec") as { stop_reason: string } | undefined;
    expect(finished?.stop_reason).toBe("end");
    // the guard protocol is removed: the gate socket handles denylist locally in the Executor
    const exec = comm.channelOf("executor")!;
    const sup = comm.channelOf("supervisor")!;
    expect(exec.relayed).toBe(0);
    expect(sup.relayed).toBeGreaterThan(3); // event copies, prompt copy, heartbeats
    const finishedTool = onDisk.find((e) => e.type === "tool_call_finished") as { result: string; status: string } | undefined;
    expect(finishedTool?.status).toBe("ok");
    expect(finishedTool?.result).toContain("Hello from the rig.");
  }, 40000);

  test("a denylisted run_command is blocked by LocalGuards: result names the rule, nothing executes", async () => {
    const { comm, rec } = await threeProcesses("script_exec_denied.jsonl");
    comm.submitPrompt("clean the build folder");
    await waitFor(() => rec.turnEnds === 1, 20000, "turn end");
    const onDisk = readJsonlFile(comm.store.path).events;
    const done = onDisk.find((e) => e.type === "tool_call_finished") as { status: string; result: string } | undefined;
    expect(done?.status).toBe("blocked");
    expect(done?.result).toContain("denylist");
    // no child process ever appeared in an Executor heartbeat
    expect(comm.state.children.executor.lastHeartbeat?.children ?? []).toEqual([]);
    expect(rec.asks).toHaveLength(0); // no question to the user, ever
  }, 40000);

  test("frozen Executor (test hook): the Supervisor detects the stall, resume triggers executor_resumed within the stall timeout, the turn completes", async () => {
    const prepared = prepareRig({ script: join(SCRIPTS, "script_exec_basic.jsonl"), agentFolder: FAKE_SYSTEM, configOverrides: { ipc: { heartbeat_s: 1 }, supervisor: { stall_timeout_s: 2, review_every_calls: 50, cost_alert_usd: 100 } }, env: { HERA_TEST_FREEZE_MS: "3500" } });
    dirs.push(...prepared.dirs);
    const config = loadConfig({ appDir: prepared.appDir, roles: "all", requireKeys: false, scripted: true, env: {} });
    const rec = recorder();
    const comm = new Communicator(rec, { workspace: prepared.workspace, config, env: prepared.env, entryMain: ENTRY, helloTimeoutMs: 15000 });
    comms.push(comm);
    await comm.start();
    const started = performance.now();
    comm.submitPrompt("read the readme");
    await waitFor(() => rec.turnEnds === 1, 25000, "turn end after stall resume");
    const elapsed = performance.now() - started;
    const onDisk = readJsonlFile(comm.store.path).events;
    const stall = onDisk.find((e) => e.type === "supervisor_intervention" && (e as { kind: string }).kind === "stall_resume") as { text: string } | undefined;
    expect(stall).toBeDefined();
    expect(stall?.text).toContain("Executor silent for");
    const resumed = onDisk.find((e) => e.type === "executor_resumed") as { reason: string } | undefined;
    expect(resumed?.reason).toBe("frozen");
    expect(onDisk.some((e) => e.type === "supervisor_intervention" && (e as { kind: string }).kind === "restart_request")).toBe(false);
    expect(comm.status().restartsThisSession).toBe(0);
    const finished = onDisk.find((e) => e.type === "turn_finished" && e.proc === "exec") as { stop_reason: string } | undefined;
    expect(finished?.stop_reason).toBe("end");
    // the freeze (3.5 s) plus detection (stall_timeout 2 s, checked every heartbeat) stays well under the resume deadline path
    expect(elapsed).toBeLessThan(15000);
    expect(comm.status().interventions["stall_resume"]).toBe(1);
  }, 40000);

  test("Executor killed mid-turn: Communicator stays responsive to /status and resumes the session from the JSONL", async () => {
    const { comm, rec } = await threeProcesses("script_sleep_short.jsonl", { harness: { local: { approval: "off" } } });
    comm.submitPrompt("run it");
    await waitFor(() => rec.events.some((e) => e.type === "tool_call_requested"), 20000, "tool requested");
    const pid = comm.status().children[0]?.pid as number;
    process.kill(pid, "SIGKILL");
    // responsive immediately
    const status = comm.status();
    expect(status.turn).toBe("running");
    await waitFor(() => rec.turnEnds === 1, 30000, "turn end after restart");
    const onDisk = readJsonlFile(comm.store.path).events;
    expect(onDisk.some((e) => e.type === "error" && e.proc === "comm" && (e as { message: string }).message.startsWith("executor exited"))).toBe(true);
    expect(onDisk.some((e) => e.type === "executor_resumed" && (e as { reason: string }).reason === "restart")).toBe(true);
    expect(onDisk.filter((e) => e.type === "session_started")).toHaveLength(1);
    expect(comm.status().restartsThisSession).toBe(1);
    expect(comm.status().children[0]?.epoch).toBe(2);
    const result = await comm.shutdown("test");
    comms.length = 0;
    expect(result.orphansSurvived).toEqual([]);
  }, 60000);

  test("HERAV1HRNS-TP01-TC-04: same run_ctx on every event from both children", async () => {
    const { comm, rec } = await threeProcesses("script_exec_basic.jsonl");
    comm.submitPrompt("read the readme");
    await waitFor(() => rec.turnEnds === 1, 20000, "turn end");
    const onDisk = readJsonlFile(comm.store.path).events;
    // Every exec event must carry a non-empty run_ctx
    const execEvents = onDisk.filter((e) => e.proc === "exec");
    expect(execEvents.length).toBeGreaterThan(0);
    const execRunCtx = (execEvents[0] as { run_ctx?: string }).run_ctx;
    expect(execRunCtx).toBeTruthy();
    for (const e of execEvents) {
      expect((e as { run_ctx?: string }).run_ctx).toBe(execRunCtx);
    }
    // Every sup event must carry a non-empty run_ctx (may differ from exec)
    const supEvents = onDisk.filter((e) => e.proc === "sup");
    if (supEvents.length > 0) {
      const supRunCtx = (supEvents[0] as { run_ctx?: string }).run_ctx;
      expect(supRunCtx).toBeTruthy();
      for (const e of supEvents) {
        expect((e as { run_ctx?: string }).run_ctx).toBe(supRunCtx);
      }
    }
  }, 40000);
});

describe("[integration] SECREMED U06 - governed profile refuses in both processes", () => {
  test("governed profile: both processes refuse, comm.start() fails", async () => {
    const prepared = prepareRig({ script: join(SCRIPTS, "script_exec_basic.jsonl"), agentFolder: FAKE_SYSTEM, configOverrides: { supervisor: { review_every_calls: 50, cost_alert_usd: 100 }, harness: { profile: "governed" } } });
    dirs.push(...prepared.dirs);
    const config = loadConfig({ appDir: prepared.appDir, roles: "all", requireKeys: false, scripted: true, env: {} });
    const rec = recorder();
    const comm = new Communicator(rec, { workspace: prepared.workspace, config, env: prepared.env, entryMain: ENTRY, helloTimeoutMs: 15000 });
    comms.push(comm);
    await expect(comm.start()).rejects.toThrow();
    await comm.shutdown("test").catch(() => undefined);
    comms.length = 0;
  }, 40000);
});
