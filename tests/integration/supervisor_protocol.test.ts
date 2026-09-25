import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowTs, toJsonl, type AgentEvent } from "../../src/events.ts";
import type { IpcMessage, IpcMessageOf, PayloadOf } from "../../src/process/envelope.ts";
import { PROTOCOL_VERSION } from "../../src/version.ts";
import { FAKE_SYSTEM, SCRIPTS, prepareRig } from "../harness/executor_rig.ts";
import { FakeComm } from "../harness/fake_comm.ts";
import { removeDir, waitFor } from "../harness/procs.ts";

const cleanup: Array<{ comm: FakeComm; dirs: string[] }> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) {
    await c.comm.shutdown(4000).catch(() => undefined);
    for (const d of c.dirs) removeDir(d);
  }
});

let idCounter = 9000;
const ev = (partial: Record<string, unknown>): AgentEvent => ({ ts: nowTs(), proc: "exec", ...partial }) as unknown as AgentEvent;

interface SupRig {
  comm: FakeComm;
  appDir: string;
  workspace: string;
  jsonlPath: string;
  fromExec<T extends IpcMessage["type"]>(type: T, payload: PayloadOf<T>, to?: "sup" | "comm"): void;
  copy(event: AgentEvent): void;
  execHeartbeat(payload: Partial<PayloadOf<"heartbeat">>): void;
  supEvents(): AgentEvent[];
}

async function startSupervisor(opts: { configOverrides?: Record<string, unknown>; existingJsonl?: AgentEvent[] } = {}): Promise<SupRig> {
  const prepared = prepareRig({ script: join(SCRIPTS, "script_sup_memory.jsonl"), agentFolder: FAKE_SYSTEM, configOverrides: { supervisor: { stall_timeout_s: 2, review_every_calls: 3, cost_alert_usd: 1 }, ...(opts.configOverrides ?? {}) } });
  const jsonlPath = join(prepared.appDir, ".agent-data", "sessions", "s.jsonl");
  mkdirSync(join(prepared.appDir, ".agent-data", "sessions"), { recursive: true });
  writeFileSync(jsonlPath, (opts.existingJsonl ?? []).map(toJsonl).join("\n") + (opts.existingJsonl !== undefined && opts.existingJsonl.length > 0 ? "\n" : ""));
  const comm = new FakeComm({ cwd: prepared.workspace, env: prepared.env, stdout: "pipe" });
  cleanup.push({ comm, dirs: prepared.dirs });
  await comm.spawn("supervisor", 1);
  await comm.waitFor((m) => m.type === "hello", 15000, "hello");
  const openId = comm.send("session_open", { session_id: "s", jsonl_path: jsonlPath, mode: opts.existingJsonl !== undefined ? "resume" : "new", workspace: prepared.workspace, app_dir: prepared.appDir, config_path: prepared.configPath });
  await comm.waitFor((m) => m.type === "ack" && (m.payload as { ref: number }).ref === openId, 20000, "session_open ack");
  const raw = (msg: Record<string, unknown>): void => comm.sendRaw({ v: PROTOCOL_VERSION, id: ++idCounter, ts: nowTs(), ...msg });
  return {
    comm,
    appDir: prepared.appDir,
    workspace: prepared.workspace,
    jsonlPath,
    fromExec: (type, payload, to = "sup") => raw({ from: "exec", to, type, payload } as unknown as Record<string, unknown>),
    copy: (event) => raw({ from: "exec", to: "comm", type: "event", payload: event }),
    execHeartbeat: (payload) => raw({ from: "exec", to: "comm", type: "heartbeat", payload: { turn_active: false, last_event_id: 1, pid: 4242, ...payload } }),
    supEvents: () => comm.received.filter((m) => m.type === "event").map((m) => m.payload as AgentEvent),
  };
}

const fromSupToExec = (comm: FakeComm, type: string): IpcMessage[] => comm.received.filter((m) => m.type === type && m.to === "exec");

describe("[integration] HERAV1SUPV-TP01 protocol (real Supervisor under FakeComm)", () => {
  test("HERAV1SUPV-TP01-TC-08..10 guard protocol removed: no guard_request/guard_verdict messages exchanged", async () => {
    const r = await startSupervisor();
    // The guard protocol is removed; the gate socket (LocalGuards) handles denylist locally in the Executor
    expect(r.comm.received.filter((m) => (m.type as string) === "guard_request" || (m.type as string) === "guard_verdict")).toHaveLength(0);
    expect(r.comm.stdoutText).toBe("");
  }, 30000);

  test("HERAV1SUPV-TP01-TC-11 guard protocol removed: no guard_request/guard_verdict messages exist", async () => {
    const r = await startSupervisor();
    // The guard protocol is removed; the gate socket handles denylist locally
    expect(r.comm.received.filter((m) => (m.type as string) === "guard_request" || (m.type as string) === "guard_verdict")).toHaveLength(0);
  }, 30000);

  test("HERAV1SUPV-TP01-TC-25/29 memory: retrieval on the prompt copy → inject {memory}; extraction on turn_finished writes the store and a memory turn_finished", async () => {
    const r = await startSupervisor();
    // a non-trivial turn: user_message, one tool call, enough text, turn_finished
    r.copy(ev({ type: "user_message", content: "<user_request>\nkeep it short\n</user_request>" }));
    r.copy(ev({ type: "tool_call_requested", id: "t1", tool: "read_file", args: {}, args_json: "{}" }));
    r.copy(ev({ type: "tool_call_finished", id: "t1", status: "ok", result: "x", result_chars: 1 }));
    r.copy(ev({ type: "text_delta", text: "a".repeat(300) }));
    r.copy(ev({ type: "turn_finished", role: "generating", uncached_input: 10, cache_write: 0, cache_read: 0, output: 5, cost_usd: 0.01, stop_reason: "end" }));
    const memTurn = await waitEvent(r, (e) => e.type === "turn_finished" && e.role === "memory");
    expect(memTurn.proc).toBe("sup");
    expect((memTurn as { uncached_input: number }).uncached_input).toBe(40);
    const memDir = join(r.appDir, ".agent-data", "memories");
    await waitFor(() => existsSync(memDir) && readdirSync(memDir).some((f) => f === "global.jsonl"), 5000, "memory file");
    const lines = readFileSync(join(memDir, "global.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: "mem_00001", text: "The user prefers terse answers", scope: "global", source_session: "s" });
    // the next prompt copy triggers retrieval → inject to exec
    r.comm.sendRaw({ v: PROTOCOL_VERSION, id: ++idCounter, from: "comm", to: "exec", type: "prompt", ts: nowTs(), payload: { text: "another request" } });
    const inject = await r.comm.waitFor((m) => m.type === "inject", 5000, "inject");
    expect(inject.to).toBe("exec");
    expect(inject.payload).toMatchObject({ kind: "memory", memory_ids: ["mem_00001"], prompt_id: "" });
    const injectText = (inject.payload as { text: string }).text;
    expect(injectText).toContain('<untrusted_content origin="memory" ref="mem_00001">');
    expect(injectText).toContain("[memory mem_00001, from session ");
    expect(injectText).toContain("The user prefers terse answers");
    expect(injectText).toContain("</untrusted_content>");
    await waitFor(() => r.supEvents().filter((e) => e.type === "turn_finished").length === 2, 5000, "second memory turn_finished");
    // the store recorded the use
    const after = readFileSync(join(memDir, "global.jsonl"), "utf8").trim().split("\n");
    expect(after).toHaveLength(2);
    expect(JSON.parse(after[1] as string)).toMatchObject({ id: "mem_00001", uses: 1 });
  }, 30000);

  test("HERAV1SUPV-TP01-TC-19/23 review after every_n_calls → inject {governance}, intervention, supervisor turn_finished; cost alert once", async () => {
    const r = await startSupervisor();
    await waitFor(() => r.comm.received.some((m) => m.type === "debug_line" && (m.payload as { op: string }).op === "reseed_done"), 5000, "reseed");
    r.copy(ev({ type: "user_message", content: "<user_request>\nedit stuff\n</user_request>" }));
    for (let i = 1; i <= 3; i++) {
      r.copy(ev({ type: "tool_call_requested", id: `t${i}`, tool: "edit", args: { file_path: join(r.workspace, `f${i}.ts`) }, args_json: "{}" }));
      r.copy(ev({ type: "tool_call_finished", id: `t${i}`, status: "ok", result: "ok", result_chars: 2 }));
    }
    const inject = await r.comm.waitFor((m) => m.type === "inject", 8000, "governance inject");
    expect(inject.payload).toMatchObject({ kind: "governance", text: expect.stringContaining("rules/coding-style.md") });
    const intervention = await waitEvent(r, (e) => e.type === "supervisor_intervention" && (e as { kind: string }).kind === "governance_note");
    expect((intervention as { turn_index: number }).turn_index).toBe(1);
    const supTurn = await waitEvent(r, (e) => e.type === "turn_finished" && e.role === "supervisor");
    expect((supTurn as { uncached_input: number }).uncached_input).toBe(80);
    r.execHeartbeat({ turn_active: true, phase: "model_call", turn_usage: { uncached_input: 1, cache_write: 0, cache_read: 0, output: 1, cost_usd: 1.25 } });
    const alert = await waitEvent(r, (e) => e.type === "supervisor_intervention" && (e as { kind: string }).kind === "cost_alert");
    expect((alert as { text: string }).text).toContain("$1.2500 exceeds the alert threshold $1.00");
    r.execHeartbeat({ turn_active: true, phase: "model_call", turn_usage: { uncached_input: 1, cache_write: 0, cache_read: 0, output: 1, cost_usd: 2.5 } });
    await Bun.sleep(300);
    expect(r.supEvents().filter((e) => e.type === "supervisor_intervention" && (e as { kind: string }).kind === "cost_alert")).toHaveLength(1);
    expect(fromSupToExec(r.comm, "cancel")).toHaveLength(0);
  }, 30000);

  test("HERAV1SUPV-TP01-TC-13/17 stall: silent Executor in a turn → resume {frozen} + intervention; no executor_resumed → restart_request", async () => {
    const r = await startSupervisor({ configOverrides: { ipc: { heartbeat_s: 1 }, supervisor: { stall_timeout_s: 2, review_every_calls: 50, cost_alert_usd: 100 } } });
    r.copy(ev({ type: "user_message", content: "<user_request>\ngo\n</user_request>" }));
    r.execHeartbeat({ turn_active: true, phase: "model_call", phase_since: nowTs() });
    const resume = await r.comm.waitFor((m) => m.type === "resume", 10000, "resume");
    expect(resume.to).toBe("exec");
    expect(resume.payload).toEqual({ reason: "frozen", phase: "model_call" });
    const stall = await waitEvent(r, (e) => e.type === "supervisor_intervention" && (e as { kind: string }).kind === "stall_resume");
    expect((stall as { text: string }).text).toContain("Executor silent for");
    const restart = await r.comm.waitFor((m) => m.type === "restart_request", 10000, "restart_request");
    expect(restart.to).toBe("comm");
    expect(restart.payload).toMatchObject({ reason: expect.stringContaining("did not confirm the resume") });
    await waitEvent(r, (e) => e.type === "supervisor_intervention" && (e as { kind: string }).kind === "restart_request");
  }, 30000);

  test("HERAV1SUPV-TP01-TC-32/33 session_open on an existing JSONL re-seeds counters; duplicate session_open ignored; shutdown exits 0", async () => {
    const existing: AgentEvent[] = [
      ev({ type: "user_message", content: "a" }),
      ev({ type: "tool_call_requested", id: "x1", tool: "read_file", args: {}, args_json: "{}" }),
      ev({ type: "tool_call_requested", id: "x2", tool: "read_file", args: {}, args_json: "{}" }),
      { ts: nowTs(), proc: "sup", type: "supervisor_intervention", kind: "guard_block", text: "blocked", turn_index: 1 },
      ev({ type: "user_message", content: "b" }),
    ];
    const r = await startSupervisor({ existingJsonl: existing });
    await waitFor(() => r.comm.received.some((m) => m.type === "debug_line" && (m.payload as { op: string }).op === "reseed_done"), 5000, "reseed");
    const done = r.comm.received.find((m) => m.type === "debug_line" && (m.payload as { op: string }).op === "reseed_done");
    expect((done?.payload as { turn_index: number }).turn_index).toBe(2);
    r.execHeartbeat({ turn_active: true, phase: "model_call", turn_usage: { uncached_input: 1, cache_write: 0, cache_read: 0, output: 1, cost_usd: 2.5 } });
    const intervention = await waitEvent(r, (e) => e.type === "supervisor_intervention");
    expect((intervention as { turn_index: number }).turn_index).toBe(2);
    const dupId = r.comm.send("session_open", { session_id: "s", jsonl_path: r.jsonlPath, mode: "resume", workspace: r.workspace, app_dir: r.appDir, config_path: join(r.appDir, ".agent-data", "config", "agent-config.json") });
    await r.comm.waitFor((m) => m.type === "ack" && (m.payload as { ref: number }).ref === dupId, 5000, "dup ack");
    expect(r.comm.received.some((m) => m.type === "debug_line" && (m.payload as { op: string }).op === "session_open_duplicate_ignored")).toBe(true);
    const code = await r.comm.shutdown(5000);
    expect(code).toBe(0);
    cleanup.length = 0;
    for (const d of [r.appDir, r.workspace]) removeDir(d);
  }, 30000);
});

async function waitEvent(r: SupRig, pred: (e: AgentEvent) => boolean, timeoutMs = 8000): Promise<AgentEvent> {
  let found: AgentEvent | undefined;
  await waitFor(() => {
    found = r.supEvents().find(pred);
    return found !== undefined;
  }, timeoutMs, "supervisor event");
  return found as AgentEvent;
}

export type { IpcMessageOf };
