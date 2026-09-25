import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Communicator, type FrontendHooks } from "../../src/communicator/core.ts";
import { loadConfig, type ResolvedConfig } from "../../src/config/load.ts";
import { readJsonlFile, type AgentEvent } from "../../src/events.ts";
import type { PayloadOf } from "../../src/process/envelope.ts";
import { tempAppDir, writeConfig } from "../harness/config_fixtures.ts";
import { REPO_ROOT, removeDir, waitFor } from "../harness/procs.ts";

const STUB = join(REPO_ROOT, "tests", "fixtures", "stub_roles", "stub_child.ts");
const ENTRY = join(REPO_ROOT, "src", "index.ts");
const dirs: string[] = [];
const comms: Communicator[] = [];
afterEach(async () => {
  for (const c of comms.splice(0)) await c.shutdown("test cleanup").catch(() => undefined);
  for (const d of dirs.splice(0)) removeDir(d);
});

interface Recorder extends FrontendHooks {
  events: AgentEvent[];
  notices: string[];
  asks: PayloadOf<"ask_user">[];
  debug: Array<{ from: string; line: PayloadOf<"debug_line"> }>;
  turnEnds: number;
}

const recorder = (): Recorder => {
  const r: Recorder = {
    events: [],
    notices: [],
    asks: [],
    debug: [],
    turnEnds: 0,
    onEvent: (e) => r.events.push(e),
    onAskUser: (a) => r.asks.push(a),
    onNotice: (l) => r.notices.push(l),
    onTurnEnd: () => r.turnEnds++,
    onDebugLine: (line, from) => r.debug.push({ from, line }),
  };
  return r;
};

function setup(behavior: string, ipc: Record<string, number> = {}): { config: ResolvedConfig; appDir: string; env: Record<string, string> } {
  const { appDir, configPath } = tempAppDir("v2_minimal", "comm");
  dirs.push(appDir);
  writeConfig(configPath, { roles: { generating: { model_id: "glm-5.2", effort: "high" } }, ipc: { heartbeat_s: 1, ...ipc } });
  const config = loadConfig({ appDir, roles: "all", requireKeys: false, scripted: true, env: {} });
  return { config, appDir, env: { HERA_STUB_ROLE_MODULE: STUB, HERA_STUB_ROLE_BEHAVIOR: behavior, HERA_SCRIPTED_ADAPTER: "1" } };
}

async function startComm(behavior: string, ipc: Record<string, number> = {}): Promise<{ comm: Communicator; rec: Recorder }> {
  const { config, appDir, env } = setup(behavior, ipc);
  const rec = recorder();
  const comm = new Communicator(rec, { workspace: appDir, config, env, helloTimeoutMs: 8000, entryMain: ENTRY });
  comms.push(comm);
  await comm.start();
  return { comm, rec };
}

const factsOf = (rec: Recorder, op: string) => rec.debug.filter((d) => d.line.op === op).map((d) => d.line);

describe("[integration] HERAV1PROC-TP01 Communicator core", () => {
  test("HERAV1PROC-TP01-TC-03/07 startup: both children ready, one prompt → events appended, acked, fanned out, turn ends", async () => {
    const { comm, rec } = await startComm("normal");
    const status = comm.status();
    expect(status.children.map((c) => c.state)).toEqual(["ready", "ready"]);
    expect(status.children.every((c) => typeof c.pid === "number")).toBe(true);
    expect(status.turn).toBe("idle");
    comm.submitPrompt("hello stub");
    expect(comm.status().turn).toBe("running");
    await waitFor(() => rec.turnEnds === 1, 8000, "turn end");
    const types = rec.events.map((e) => e.type);
    expect(types).toEqual(["turn_started", "tool_call_requested", "text_delta", "turn_finished"]);
    expect(rec.events.every((e) => e.proc === "exec")).toBe(true);
    const onDisk = readJsonlFile(comm.store.path).events;
    expect(onDisk.map((e) => e.type)).toEqual(types);
    expect(comm.status().turn).toBe("idle");
    expect(comm.status().turnToolCalls).toBe(0);
    expect(comm.status().eventsAppended).toBe(4);
    // fan-out: the Supervisor stub saw the prompt copy and the tool_call_requested copy (facts arrive as debug_line)
    await waitFor(() => factsOf(rec, "prompt_copy").length === 1, 3000, "prompt copy fact");
    expect(factsOf(rec, "prompt_copy")[0]).toMatchObject({ text: "hello stub", proc: "sup" });
    await waitFor(() => factsOf(rec, "guard_order").length === 1, 3000, "guard order fact");
    const order = factsOf(rec, "guard_order")[0]?.["order"] as Array<{ kind: string }>;
    expect(order.map((o) => o.kind)).toEqual(["event_copy"]);
    // the Executor saw the ack before continuing (write-ahead)
    expect(factsOf(rec, "ack_observed")).toHaveLength(1);
    const exec = comm.channelOf("executor")!;
    expect(exec.sent.ack).toBe(4);
    expect(exec.received.event).toBe(4);
    const result = await comm.shutdown("test");
    expect(result.killed).toEqual([]);
    expect(comm.status().children.map((c) => c.exitCode)).toEqual([0, 0]);
    comms.length = 0;
  });

  test("HERAV1PROC-TP01-TC-14/15 Executor exit mid-turn: error line, respawn, resume with the synthetic note; second exit ends the turn", async () => {
    const { comm, rec } = await startComm("exec:exit_mid_turn");
    comm.submitPrompt("crash me");
    await waitFor(() => rec.turnEnds === 1, 15000, "turn end after restart");
    const types = rec.events.map((e) => `${e.proc}:${e.type}`);
    expect(types[0]).toBe("exec:turn_started");
    expect(types).toContain("comm:error");
    const errors = rec.events.filter((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
    expect(errors[0]?.message).toMatch(/^executor exited: code 1$/);
    expect(errors[0]?.category).toBe("process");
    expect(errors.some((e) => e.message.startsWith("restart performed"))).toBe(true);
    const prompts = factsOf(rec, "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.["note"]).toBeNull();
    expect(prompts[1]?.["note"]).toBe("turn resumed after Executor restart");
    expect(rec.events.filter((e) => e.type === "turn_finished")).toHaveLength(1);
    expect(comm.status().restartsThisSession).toBe(1);
    expect(comm.status().children[0]?.epoch).toBe(2);
    expect(comm.status().turn).toBe("idle");
    expect(rec.notices.some((n) => n.startsWith("NOTICE: Executor exited (code 1) -> restarting"))).toBe(true);
    // second prompt in the same session: fresh budget; the stub exits again on the first attempt and resumes on the second
    comm.submitPrompt("crash again");
    await waitFor(() => rec.turnEnds === 2, 15000, "second turn end");
    expect(comm.status().restartsThisSession).toBe(2);
    expect(readJsonlFile(comm.store.path).events.filter((e) => e.type === "turn_finished")).toHaveLength(2);
  });

  test("HERAV1PROC-TP01-TC-16 restart budget 0: an Executor exit mid-turn ends the turn with an error line and keeps the Communicator responsive", async () => {
    const { comm, rec } = await startComm("exec:exit_mid_turn", { restart_budget: 0 });
    comm.submitPrompt("crash me");
    await waitFor(() => rec.turnEnds === 1, 10000, "turn end");
    const errors = rec.events.filter((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
    expect(errors.map((e) => e.message)).toEqual(["executor exited: code 1", "turn ended: Executor exited again (code 1) and the restart budget (0) is exhausted"]);
    expect(rec.events.filter((e) => e.type === "turn_finished")).toHaveLength(0);
    expect(comm.status().turn).toBe("idle");
    expect(comm.status().restartsThisSession).toBe(0);
    expect(comm.status().children[0]?.state).toBe("exited");
    // still responsive: /status answered above; the next prompt spawns a fresh Executor (which exits again → turn ends again)
    comm.submitPrompt("again");
    await waitFor(() => rec.turnEnds === 2, 10000, "second turn end");
    expect(comm.status().children[0]?.epoch).toBe(2);
  });

  test("HERAV1PROC-TP01-TC-17 Supervisor exit: error line, notice, respawn with session_open resume; Executor keeps running", async () => {
    const { comm, rec } = await startComm("normal");
    const supPid = comm.status().children[1]?.pid;
    expect(supPid).toBeDefined();
    process.kill(supPid as number, "SIGKILL");
    await waitFor(() => comm.status().children[1]?.epoch === 2 && comm.status().children[1]?.state === "ready", 8000, "supervisor respawn");
    const errors = rec.events.filter((e) => e.type === "error").map((e) => (e as { message: string }).message);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^supervisor exited: (signal SIGKILL|code \d+)$/);
    expect(rec.notices.some((n) => /^NOTICE: Supervisor exited \((signal SIGKILL|code \d+)\) -> respawning\./.test(n))).toBe(true);
    expect(comm.status().children[0]?.epoch).toBe(1);
    comm.submitPrompt("after supervisor restart");
    await waitFor(() => rec.turnEnds === 1, 8000, "turn end");
    await waitFor(() => factsOf(rec, "prompt_copy").length === 1, 3000, "prompt copy reached the new supervisor");
  });

  test("HERAV1PROC-TP01-TC-18 idle Executor exits: respawn up to 3 within 60 s, then stop until the next prompt", async () => {
    const { comm, rec } = await startComm("normal");
    const killExec = async (): Promise<void> => {
      const pid = comm.status().children[0]?.pid as number;
      process.kill(pid, "SIGKILL");
      await waitFor(() => comm.status().children[0]?.pid !== pid && comm.status().children[0]?.state !== "spawning", 8000, "exit processed");
    };
    for (let i = 0; i < 3; i++) {
      await killExec();
      await waitFor(() => comm.status().children[0]?.state === "ready", 8000, `respawn ${i + 1}`);
    }
    expect(comm.status().children[0]?.epoch).toBe(4);
    const pid = comm.status().children[0]?.pid as number;
    process.kill(pid, "SIGKILL");
    await waitFor(() => rec.notices.some((n) => n.startsWith("ERROR: Executor exited 4 times")), 8000, "stop notice");
    await Bun.sleep(300);
    expect(comm.status().children[0]?.state).toBe("exited");
    expect(comm.status().children[0]?.epoch).toBe(4);
    expect(rec.events.filter((e) => e.type === "error")).toHaveLength(4);
    comm.submitPrompt("wake up");
    await waitFor(() => rec.turnEnds === 1, 10000, "turn after idle stop");
    expect(comm.status().children[0]?.epoch).toBe(5);
  });

  test("HERAV1PROC-TP01-TC-19 restart_request from the Supervisor kills the Executor and follows the exit path", async () => {
    const { comm, rec } = await startComm("normal");
    comm.submitPrompt("first");
    await waitFor(() => rec.turnEnds === 1, 8000, "first turn");
    // inject a restart_request as if the Supervisor sent it
    const sup = comm.channelOf("supervisor")!;
    sup.dispatch({ v: 1, id: 5000, from: "sup", to: "comm", type: "restart_request", ts: "2026-01-15 10:00:00.000", payload: { reason: "stall" } });
    await waitFor(() => comm.status().children[0]?.epoch === 2 && comm.status().children[0]?.state === "ready", 8000, "executor respawn");
    expect(rec.notices.some((n) => n.includes("requested an Executor restart (stall)"))).toBe(true);
    expect(rec.events.filter((e) => e.type === "error").map((e) => (e as { message: string }).message)[0]).toMatch(/^executor exited: signal SIGTERM|^executor exited: code/);
  });

  test("HERAV1PROC-TP01-TC-20 shutdown: ignore_shutdown Executor is killed after the timeout, tool child reaped, Supervisor exits 0", async () => {
    const { comm, rec } = await startComm("exec:ignore_shutdown", { shutdown_timeout_ms: 500 });
    comm.submitPrompt("spawn a tool child");
    await waitFor(() => rec.turnEnds === 1, 8000, "turn");
    await waitFor(() => (comm.state.children.executor.lastHeartbeat?.children?.length ?? 0) === 1, 4000, "heartbeat with children");
    const toolPid = comm.state.children.executor.lastHeartbeat?.children?.[0] as number;
    const started = performance.now();
    const result = await comm.shutdown("test");
    comms.length = 0;
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.killed).toEqual(["executor"]);
    expect(result.orphansSurvived).toEqual([]);
    expect(rec.notices.some((n) => n.includes("executor did not exit within 500 ms -> killed"))).toBe(true);
    await Bun.sleep(200);
    let alive = true;
    try {
      process.kill(toolPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(comm.status().children[1]?.exitCode).toBe(0);
    expect(comm.store.isOpen).toBe(false);
  });

  test("HERAV1PROC-TP01-TC-21 a child that exits before hello fails start() with a named error and no restart loop", async () => {
    const { config, appDir, env } = setup("sup:exit_on_spawn");
    const rec = recorder();
    const comm = new Communicator(rec, { workspace: appDir, config, env, helloTimeoutMs: 5000, entryMain: ENTRY });
    let message = "";
    try {
      await comm.start();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("supervisor exited before hello");
    await comm.shutdown("abort");
    expect(rec.events).toHaveLength(0);
  });

  test("HERAV1PROC-TP01-TC-22 heartbeats recorded per child; Executor beats relayed to the Supervisor; /status has ages", async () => {
    const { comm, rec } = await startComm("normal");
    await waitFor(() => comm.status().children.every((c) => c.heartbeatAgeMs !== undefined), 4000, "heartbeats");
    await waitFor(() => factsOf(rec, "relayed_heartbeat").length >= 1, 4000, "relayed heartbeat fact");
    expect(factsOf(rec, "relayed_heartbeat")[0]?.["from"]).toBe("exec");
    const s = comm.status();
    expect(s.children[0]?.heartbeatAgeMs).toBeLessThan(3000);
    expect(s.children[0]?.phase).toBe("idle");
  });
});
