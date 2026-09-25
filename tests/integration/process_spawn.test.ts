import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { spawnCommand } from "../../src/process/bootstrap.ts";
import type { IpcMessage } from "../../src/process/envelope.ts";
import { FakeComm } from "../harness/fake_comm.ts";
import { HeraProc } from "../harness/hera_proc.ts";
import { REPO_ROOT, makeTempDir, removeDir } from "../harness/procs.ts";
import pkg from "../../package.json" with { type: "json" };

const STUB = join(REPO_ROOT, "tests", "fixtures", "stub_roles", "stub_child.ts");
const CONFIG = join(REPO_ROOT, "tests", "fixtures", "config_test.json");

const comms: FakeComm[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of comms.splice(0)) await c.shutdown(1000);
  for (const d of dirs.splice(0)) removeDir(d);
});

function stubComm(behavior: string, extraEnv: Record<string, string> = {}, opts: { autoAck?: boolean; stdout?: "ignore" | "pipe" } = {}): FakeComm {
  const comm = new FakeComm({ env: { HERA_STUB_ROLE_MODULE: STUB, HERA_STUB_ROLE_BEHAVIOR: behavior, ...extraEnv }, ...opts });
  comms.push(comm);
  return comm;
}

function sessionOpenPayload(dir: string) {
  return { session_id: "s_test", jsonl_path: join(dir, "s_test.jsonl"), mode: "new" as const, workspace: dir, app_dir: dir, config_path: CONFIG };
}

const stubFact = (m: IpcMessage, op: string): boolean => m.type === "debug_line" && (m.payload as { dom?: string; op?: string }).dom === "stub" && (m.payload as { op?: string }).op === op;

describe("[integration] HERAV1PROC-TP01 spawn and handshake (FakeComm parent)", () => {
  test("HERAV1PROC-TP01-TC-01 spawnCommand shape in both modes", () => {
    expect(spawnCommand("executor", 1, false, "bunexe", "C:/repo/src/index.ts")).toEqual(["bunexe", "C:/repo/src/index.ts", "--role", "executor", "--epoch", "1"]);
    expect(spawnCommand("supervisor", 2, true, "C:/tools/hera.exe", "B:/~BUN/root/index.ts")).toEqual(["C:/tools/hera.exe", "--role", "supervisor", "--epoch", "2"]);
    expect(spawnCommand("executor", 1)).toContain("--epoch");
  });

  test("HERAV1PROC-TP01-TC-02 normal stub sends hello with role, pid, version, standalone, epoch 1 and acks session_open after loading", async () => {
    const dir = makeTempDir("spawn_normal");
    dirs.push(dir);
    const comm = stubComm("normal");
    const started = performance.now();
    await comm.spawn("executor", 1);
    const hello = await comm.waitFor((m) => m.type === "hello", 5000, "hello");
    const readyMs = performance.now() - started;
    expect(hello.type).toBe("hello");
    if (hello.type === "hello") {
      expect(hello.payload.role).toBe("executor");
      expect(hello.payload.pid).toBe(comm.pid ?? -1);
      expect(hello.payload.version).toBe(pkg.version);
      expect(hello.payload.standalone).toBe(process.env["HERA_TEST_BINARY"] !== undefined && process.env["HERA_TEST_BINARY"] !== "");
      expect(hello.payload.epoch).toBe(1);
    }
    expect(hello.id).toBe(1);
    expect(readyMs).toBeLessThan(process.env["HERA_TEST_BINARY"] ? 500 : 3000);
    comm.autoAck = false;
    const openId = comm.send("session_open", sessionOpenPayload(dir));
    const loaded = await comm.waitFor((m) => stubFact(m, "session_open"), 5000, "session_open fact");
    const ack = await comm.waitFor((m) => m.type === "ack" && m.payload.ref === openId, 5000, "session_open ack");
    expect(comm.received.indexOf(loaded)).toBeLessThan(comm.received.indexOf(ack));
    const fields = loaded.payload as { keys_visible: string[]; mode: string; env: { scripted: string | null } };
    expect(fields.mode).toBe("new");
    expect(fields.keys_visible).toEqual(["app_dir", "config_path", "jsonl_path", "mode", "session_id", "workspace"]);
  });

  test("HERAV1PROC-TP01-TC-04 (child side) no_hello stub never sends hello; the parent's timeout decides", async () => {
    const comm = stubComm("no_hello");
    await comm.spawn("executor", 1);
    await Bun.sleep(1200);
    expect(comm.received.some((m) => m.type === "hello")).toBe(false);
    expect(comm.exitCode).toBeNull();
    comm.kill();
    expect(await comm.waitExit(2000)).toBeDefined();
  });

  test("HERAV1PROC-TP01-TC-05 --role executor by hand exits 2 'must be spawned by the Communicator'", async () => {
    const hera = new HeraProc({ workspace: REPO_ROOT });
    const result = await hera.run(["--role", "executor", "--epoch", "1"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("must be spawned by the Communicator");
    const bad = await hera.run(["--role", "auditor"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("executor, supervisor");
  });

  test("HERAV1PROC-TP01-TC-06 (child side) reject probe: invalid messages are dropped by the parent, child stays alive", async () => {
    const dir = makeTempDir("spawn_reject");
    dirs.push(dir);
    const comm = stubComm("reject_probe");
    await comm.spawn("executor", 1);
    await comm.waitFor((m) => m.type === "hello", 5000, "hello");
    comm.send("session_open", sessionOpenPayload(dir));
    await comm.waitFor((m) => stubFact(m, "session_open"), 5000, "session_open fact");
    await Bun.sleep(100);
    expect(comm.rejected).toHaveLength(3);
    expect(comm.rejected.map((r) => r.reason).join("|")).toMatch(/version/);
    expect(comm.rejected.map((r) => r.reason).join("|")).toMatch(/gossip/);
    expect(comm.rejected.map((r) => r.reason).join("|")).toMatch(/ts/);
    expect(comm.exitCode).toBeNull();
  });

  test("HERAV1PROC-TP01-TC-13 (child side) heartbeats every heartbeat_s with pid and last_event_id; none acknowledged", async () => {
    const dir = makeTempDir("spawn_hb");
    dirs.push(dir);
    const comm = stubComm("normal");
    await comm.spawn("executor", 1);
    await comm.waitFor((m) => m.type === "hello", 5000, "hello");
    comm.send("session_open", sessionOpenPayload(dir));
    await comm.waitFor((m) => stubFact(m, "session_open"), 5000, "loaded");
    const before = comm.received.filter((m) => m.type === "heartbeat").length;
    await Bun.sleep(3200);
    const beats = comm.received.filter((m) => m.type === "heartbeat");
    expect(beats.length - before).toBeGreaterThanOrEqual(2);
    const last = beats[beats.length - 1]!;
    if (last.type === "heartbeat") {
      expect(last.payload.pid).toBe(comm.pid ?? -1);
      expect(last.payload.turn_active).toBe(false);
      expect(last.payload.phase).toBe("idle");
    }
    expect(comm.sent.filter((m) => m.type === "ack").map((m) => m.payload.ref)).not.toContain(last.id);
  });

  test("HERAV1PROC-TP01-TC-24 child without --epoch reports epoch 0", async () => {
    const comm = stubComm("epoch_zero");
    await comm.spawn("executor", 1);
    const hello = await comm.waitFor((m) => m.type === "hello", 5000, "hello");
    if (hello.type === "hello") expect(hello.payload.epoch).toBe(0);
  });

  test("HERAV1PROC-TP01-TC-34 HERA_SCRIPTED_ADAPTER, AGENT_APP_DIR, AGENT_CONFIG reach the child environment", async () => {
    const dir = makeTempDir("spawn_env");
    dirs.push(dir);
    const comm = stubComm("normal", { HERA_SCRIPTED_ADAPTER: join(dir, "script.jsonl"), AGENT_APP_DIR: dir, AGENT_CONFIG: CONFIG });
    await comm.spawn("supervisor", 1);
    await comm.waitFor((m) => m.type === "hello", 5000, "hello");
    comm.send("session_open", sessionOpenPayload(dir));
    const loaded = await comm.waitFor((m) => stubFact(m, "session_open"), 5000, "loaded");
    const env = (loaded.payload as { env: { scripted: string; app_dir: string; config: string } }).env;
    expect(env.scripted).toBe(join(dir, "script.jsonl"));
    expect(env.app_dir).toBe(dir);
    expect(env.config).toBe(CONFIG);
  });

  test("HERAV1PROC-TP01-TC-37 (child side) child stdout never reaches the parent's stdout", async () => {
    const dir = makeTempDir("spawn_noise");
    dirs.push(dir);
    const comm = stubComm("stdout_noise", {}, { stdout: "ignore" });
    await comm.spawn("executor", 1);
    await comm.waitFor((m) => m.type === "hello", 5000, "hello");
    comm.send("session_open", sessionOpenPayload(dir));
    await comm.waitFor((m) => stubFact(m, "session_open"), 5000, "loaded");
    expect(comm.stdoutText).toBe("");
    expect(comm.exitCode).toBeNull();
  });

  test("HERAV1PROC-TP01-TC-25 (child side) channel close makes the child exit within 1 s and kill its tool child", async () => {
    const dir = makeTempDir("spawn_disc");
    dirs.push(dir);
    const comm = stubComm("ignore_shutdown");
    await comm.spawn("executor", 1);
    await comm.waitFor((m) => m.type === "hello", 5000, "hello");
    comm.send("session_open", sessionOpenPayload(dir));
    await comm.waitFor((m) => stubFact(m, "session_open"), 5000, "loaded");
    const beat = await comm.waitFor((m) => m.type === "heartbeat" && (m.payload.children?.length ?? 0) > 0, 5000, "heartbeat with children");
    const toolPid = beat.type === "heartbeat" ? beat.payload.children![0]! : 0;
    expect(toolPid).toBeGreaterThan(0);
    const proc = (comm as unknown as { proc: BunSubprocess }).proc;
    const closedAt = performance.now();
    proc.disconnect();
    const exit = await comm.waitExit(3000);
    expect(exit).toBeDefined();
    expect(performance.now() - closedAt).toBeLessThan(1500);
    await Bun.sleep(100);
    let alive = true;
    try {
      process.kill(toolPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  test("shutdown message: finalizer runs, exit 0", async () => {
    const dir = makeTempDir("spawn_shutdown");
    dirs.push(dir);
    const comm = stubComm("normal");
    await comm.spawn("supervisor", 1);
    await comm.waitFor((m) => m.type === "hello", 5000, "hello");
    comm.send("session_open", sessionOpenPayload(dir));
    await comm.waitFor((m) => stubFact(m, "session_open"), 5000, "loaded");
    const code = await comm.shutdown(3000);
    expect(code).toBe(0);
    expect(comm.received.some((m) => stubFact(m, "shutdown"))).toBe(true);
  });
});
