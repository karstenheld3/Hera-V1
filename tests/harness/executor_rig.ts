// Executor rig (HERAV1EXEC-TP01 section 8): a real Executor process under FakeComm with the scripted adapter,
// a temp app dir (shipped data files + fake_system prompt system), and a temp workspace.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "../../src/events.ts";
import type { IpcMessage, IpcMessageOf, PayloadOf } from "../../src/process/envelope.ts";
import { PROTOCOL_VERSION } from "../../src/version.ts";
import { tempAppDir, writeConfig } from "./config_fixtures.ts";
import { FakeComm } from "./fake_comm.ts";
import { REPO_ROOT, makeTempDir, waitFor } from "./procs.ts";

export const FAKE_SYSTEM = join(REPO_ROOT, "tests", "fixtures", "fake_system");
export const SCRIPTS = join(REPO_ROOT, "tests", "fixtures", "scripts");

export interface RigOptions {
  script: string;
  configOverrides?: Record<string, unknown>;
  agentFolder?: string;
  env?: Record<string, string>;
  autoAck?: boolean;
  ackDelayMs?: number;
}

export interface ExecutorRig {
  comm: FakeComm;
  appDir: string;
  workspace: string;
  configPath: string;
  sessionId: string;
  jsonlPath: string;
  events(): AgentEvent[];
  eventsOf<T extends AgentEvent["type"]>(type: T): Array<Extract<AgentEvent, { type: T }>>;
  waitForEvent<T extends AgentEvent["type"]>(type: T, timeoutMs?: number, pred?: (e: Extract<AgentEvent, { type: T }>) => boolean): Promise<Extract<AgentEvent, { type: T }>>;
  waitForMessage(type: IpcMessage["type"], timeoutMs?: number): Promise<IpcMessage>;
  prompt(text: string, note?: string): number;
  /** a message as if from the Supervisor (relayed by the Communicator) */
  fromSupervisor<T extends IpcMessage["type"]>(type: T, payload: PayloadOf<T>): void;
  writeJsonl(): string;
  shutdown(): Promise<number | null>;
  cleanupDirs: string[];
}

export function prepareRig(opts: RigOptions): { appDir: string; workspace: string; configPath: string; env: Record<string, string>; dirs: string[] } {
  const { appDir, configPath } = tempAppDir("v2_minimal", "exec");
  const workspace = makeTempDir("ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# Sample Workspace\n\nHello from the rig.\n");
  writeFileSync(join(workspace, "src", "a.ts"), "export const a = 1;\n");
  writeConfig(configPath, { roles: { generating: { model_id: "glm-5.2", effort: "high" } }, agent_folder: opts.agentFolder ?? FAKE_SYSTEM, ipc: { heartbeat_s: 1 }, ...(opts.configOverrides ?? {}) });
  // scripts refer to the temp workspace as {WS}; a materialized copy carries the real path (forward slashes)
  const scriptText = readFileSync(opts.script, "utf8").replaceAll("{WS}", workspace.replace(/\\/g, "/"));
  const scriptPath = join(appDir, "script.jsonl");
  writeFileSync(scriptPath, scriptText);
  const env: Record<string, string> = { HERA_SCRIPTED_ADAPTER: scriptPath, HERA_DEBUG_LINES: "1", ...(opts.env ?? {}) };
  return { appDir, workspace, configPath, env, dirs: [appDir, workspace] };
}

let supCounter = 5000;

/** Spawns the real Executor, completes hello and session_open (mode new unless `resumePath`). */
export async function startExecutor(opts: RigOptions & { resumePath?: string; orphans?: number[]; epoch?: number }): Promise<ExecutorRig> {
  const prepared = prepareRig(opts);
  const comm = new FakeComm({ cwd: prepared.workspace, env: prepared.env, autoAck: opts.autoAck ?? true, ackDelayMs: opts.ackDelayMs ?? 0, stdout: "pipe" });
  await comm.spawn("executor", opts.epoch ?? 1);
  await comm.waitFor((m) => m.type === "hello", 15000, "hello");
  const sessionId = "2026-01-15_100000_test";
  const jsonlPath = opts.resumePath ?? join(prepared.appDir, ".agent-data", "sessions", `${sessionId}.jsonl`);
  const openId = comm.send("session_open", { session_id: sessionId, jsonl_path: jsonlPath, mode: opts.resumePath !== undefined ? "resume" : "new", workspace: prepared.workspace, app_dir: prepared.appDir, config_path: prepared.configPath, ...(opts.orphans !== undefined ? { orphans: opts.orphans } : {}) });
  await comm.waitFor((m) => m.type === "ack" && (m.payload as { ref: number }).ref === openId, 20000, "session_open ack");
  const events = (): AgentEvent[] => comm.received.filter((m) => m.type === "event").map((m) => m.payload as AgentEvent);
  const rig: ExecutorRig = {
    comm,
    appDir: prepared.appDir,
    workspace: prepared.workspace,
    configPath: prepared.configPath,
    sessionId,
    jsonlPath,
    events,
    eventsOf: <T extends AgentEvent["type"]>(type: T) => events().filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type),
    async waitForEvent(type, timeoutMs = 10000, pred) {
      let found: AgentEvent | undefined;
      await waitFor(() => {
        found = events().find((e) => e.type === type && (pred === undefined || pred(e as never)));
        return found !== undefined;
      }, timeoutMs, `event ${type}`);
      return found as never;
    },
    waitForMessage: (type, timeoutMs = 10000) => comm.waitFor((m) => m.type === type, timeoutMs, type),
    prompt: (text, note) => comm.send("prompt", note !== undefined ? { text, note } : { text }),
    fromSupervisor(type, payload) {
      const msg: IpcMessageOf<typeof type> = { v: PROTOCOL_VERSION, id: ++supCounter, from: "sup", to: "exec", type, ts: new Date().toISOString().replace("T", " ").replace("Z", "").slice(0, 23), run_ctx: "", seq: supCounter, payload };
      comm.sendRaw(msg);
    },
    writeJsonl() {
      mkdirSync(join(prepared.appDir, ".agent-data", "sessions"), { recursive: true });
      writeFileSync(jsonlPath, `${events()
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`);
      return jsonlPath;
    },
    shutdown: () => comm.shutdown(4000),
    cleanupDirs: prepared.dirs,
  };
  return rig;
}

/** Index positions of message types in FakeComm's recording (for order assertions). */
export function recordedTypes(comm: FakeComm): string[] {
  return comm.recorded.map((r) => `${r.dir}:${r.msg.type}${r.msg.type === "event" ? `(${(r.msg.payload as AgentEvent).type})` : ""}`);
}
