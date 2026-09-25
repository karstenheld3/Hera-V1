import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonlFile, type AgentEvent } from "../../src/events.ts";
import { assertNoSecretLeak } from "../harness/assertions.ts";
import { FAKE_SYSTEM, SCRIPTS, prepareRig } from "../harness/executor_rig.ts";
import { HeraProc } from "../harness/hera_proc.ts";
import { removeDir } from "../harness/procs.ts";
import pkg from "../../package.json" with { type: "json" };

const IPPS = "e:\\Dev\\Hera-V0\\.agent";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function rig(script: string, overrides: Record<string, unknown> = {}, agentFolder = FAKE_SYSTEM): { proc: HeraProc; appDir: string; workspace: string; env: Record<string, string> } {
  const prepared = prepareRig({ script: join(SCRIPTS, script), agentFolder, configOverrides: { supervisor: { review_every_calls: 50, cost_alert_usd: 100 }, ...overrides } });
  dirs.push(...prepared.dirs);
  const proc = new HeraProc({ workspace: prepared.workspace, appDir: prepared.appDir, scriptPath: prepared.env["HERA_SCRIPTED_ADAPTER"] as string, env: { HERA_DECOY_KEY: "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789" } });
  return { proc, appDir: prepared.appDir, workspace: prepared.workspace, env: prepared.env };
}

function sessionEvents(appDir: string): AgentEvent[] {
  const dir = join(appDir, ".agent-data", "sessions");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  return readJsonlFile(join(dir, files[files.length - 1] as string)).events;
}

describe("[blackbox] HERAV1CLI-TP01 headless runs over three processes", () => {
  test("HERAV1CLI-TP01-TC-19/20 -p with jsonl: exit 0, pure JSONL stdout, notices on stderr, session_started first, tool line precedes execution", async () => {
    const { proc, appDir } = rig("script_exec_basic.jsonl");
    const result = await proc.runHeadless("read the readme", { outputFormat: "jsonl", timeoutMs: 60000 });
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types[0]).toBe("session_started");
    expect(types).toContain("tool_call_requested");
    expect(types.indexOf("tool_call_requested")).toBeLessThan(types.indexOf("tool_call_finished"));
    // The executor's turn_finished must exist; the supervisor may emit model_called after it
    expect(types).toContain("turn_finished");
    expect(result.stderr).toContain(`Hera ${pkg.version} [SCRIPTED] | generating: glm-5.2 (high)`);
    expect(result.stderr).toContain("Keys: not required (scripted adapter)");
    expect(result.stderr).toMatch(/Processes: executor pid='\d+', supervisor pid='\d+'\. Ready in \d+\.\d secs\./);
    expect(result.stderr).toContain("Created ");
    const onDisk = sessionEvents(appDir);
    expect(onDisk.map((e) => e.type)).toEqual(types);
    assertNoSecretLeak([result.stdout, result.stderr], undefined, ["sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789"]);
  }, 90000);

  test("HERAV1CLI-TP01-TC-21 -p text mode prints the final assistant text; /status built-in answers without a model call", async () => {
    const { proc } = rig("script_exec_basic.jsonl");
    const result = await proc.runHeadless("read the readme", { outputFormat: "text", timeoutMs: 60000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("The README says hello from the rig.");
    expect(result.stdout).toContain("[tool] read_file");
    expect(result.stdout).toContain("Turn: in=2200 (cache 900) out=50");
    const status = await proc.runHeadless("/status", { outputFormat: "text", timeoutMs: 60000 });
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/executor {3}pid='\d+' ready/);
    expect(status.stdout).toContain("Turn: idle");
    expect(status.stdout).not.toContain("turn_started");
  }, 90000);

  test("HERAV1CLI-TP01-TC-22 exit 3 on provider failure; exit 2 on a config error without spawning; exit 4 on a declined continue", async () => {
    const failing = rig("script_provider_error.jsonl");
    const r3 = await failing.proc.runWithRetry(["-p", "go", "--output-format", "jsonl"], { timeoutMs: 60000 });
    expect(r3.code).toBe(3);
    expect(r3.stdout).toContain('"category":"provider"');
    const broken = rig("script_exec_basic.jsonl");
    writeFileSync(join(broken.appDir, ".agent-data", "config", "agent-config.json"), '{ "roles": { "generating": { "model_id": "gpt-6-astra", "effort": "high" } } }');
    const r2 = await broken.proc.runWithRetry(["-p", "go", "--output-format", "text"], { timeoutMs: 60000 });
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain("gpt-6-astra");
    expect(r2.stderr).not.toContain("Processes:");
    expect(existsSync(join(broken.appDir, ".agent-data", "sessions")) ? readdirSync(join(broken.appDir, ".agent-data", "sessions")) : []).toEqual([]);
    const limit = rig("script_41_calls.jsonl", { max_tool_calls_per_prompt: 2 });
    const r4 = await limit.proc.runWithRetry(["-p", "loop", "--output-format", "jsonl"], { timeoutMs: 60000 });
    expect(r4.code).toBe(4);
    expect(r4.stdout).toContain('"category":"limit"');
  }, 120000);

  test("HERAV1CLI-TP01-TC-23 --prompt-file: prompt_step lines, three turns in one session, exit 0; malformed file exit 2", async () => {
    const { proc, appDir, workspace } = rig("script_exec_basic.jsonl");
    const file = join(workspace, "PROMPTS.md");
    writeFileSync(file, "```\nread the readme\n```\n\n---\nstep two\n````\nand again\n````\n");
    const result = await proc.run(["--prompt-file", file, "--output-format", "jsonl"], { timeoutMs: 60000 });
    expect(result.code).toBe(0);
    const events = sessionEvents(appDir);
    const steps = events.filter((e) => e.type === "prompt_step") as Array<Extract<AgentEvent, { type: "prompt_step" }>>;
    expect(steps.map((s) => [s.index, s.total, s.proc])).toEqual([[1, 2, "comm"], [2, 2, "comm"]]);
    expect(events.filter((e) => e.type === "turn_finished" && e.proc === "exec")).toHaveLength(2);
    expect(result.stdout).toContain('"type":"prompt_step"');
    writeFileSync(file, "not a fence\n```\nx\n```\n");
    const bad = await proc.run(["--prompt-file", file], { timeoutMs: 30000 });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("first_line_fence");
    expect(bad.stderr).not.toContain("Processes:");
  }, 120000);

  test("HERAV1CLI-TP01-TC-24 denylisted run_command: blocked result, no execution, exit 0", async () => {
    const { proc, appDir } = rig("script_exec_denied.jsonl");
    const result = await proc.runHeadless("clean the build folder", { outputFormat: "text", timeoutMs: 60000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("blocked by denylist");
    expect(result.stdout).not.toMatch(/\[y\/n\]|approve/i);
    const events = sessionEvents(appDir);
    expect(events.some((e) => e.type === "tool_call_finished" && (e as { status: string }).status === "blocked")).toBe(true);
  }, 90000);

  test("HERAV1CLI-TP01-TC-25 -p /prime against the real IPPS folder: exit 0, session_started carries the byte-verbatim prompt with the IPPS rules", async () => {
    if (!existsSync(IPPS)) return;
    const { proc, appDir } = rig("script_exec_basic.jsonl", {}, IPPS);
    const result = await proc.runHeadless("/prime", { outputFormat: "jsonl", timeoutMs: 90000 });
    expect(result.code).toBe(0);
    const events = sessionEvents(appDir);
    const started = events[0] as Extract<AgentEvent, { type: "session_started" }>;
    expect(started.type).toBe("session_started");
    expect(started.system_prompt).toContain("<MEMORY[agent-behavior.md]>");
    expect(started.tool_definitions).toHaveLength(15);
    const user = events.find((e) => e.type === "user_message") as Extract<AgentEvent, { type: "user_message" }>;
    expect(user.expanded_workflow).toBe("prime");
    expect(user.content).toContain("@[/prime] is a [Workflow]:");
    expect(readFileSync(join(appDir, ".agent-data", "sessions", readdirSync(join(appDir, ".agent-data", "sessions"))[0] as string), "utf8").split("\n")[0]).toContain('"type":"session_started"');
  }, 120000);

  test("HERAV1CLI-TP01-TC-26 piped console: prompt, /status during idle, queued prompt notice, /exit → exit 0", async () => {
    const { proc } = rig("script_exec_basic.jsonl");
    const handle = proc.startPiped([]);
    handle.send("read the readme");
    handle.send("/status");
    handle.send("and again");
    await Bun.sleep(3000);
    handle.send("/exit");
    const code = await handle.waitExit(20000);
    expect(code).toBe(0);
    const out = handle.stdout();
    expect(out).toContain("The README says hello from the rig.");
    expect(out).toMatch(/Session: '\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{4}'/);
    expect(out).toContain("Second turn answer.");
  }, 60000);
});

describe("[blackbox] U08 CLI approval widget", () => {
  test("TC-32: pipe mode pending → y → resolvePending(allow); TC-33: pipe mode pending → n → resolvePending(deny)", async () => {
    const { Console } = await import("../../src/cli/console.ts");
    type Communicator = InstanceType<typeof import("../../src/communicator/core.ts").Communicator>;
    const calls: string[] = [];
    const mockComm = {
      submitPrompt: () => {},
      answer: () => {},
      continueDecision: () => {},
      cancel: () => {},
      appendOwnEvent: () => {},
      resolvePending: (effectId: string, decision: "allow" | "deny") => { calls.push(`${effectId}:${decision}`); },
      status: () => ({ turn: "idle" }),
      sessionId: "s",
      hasSession: true,
    } as unknown as Communicator;
    const lines: string[] = [];
    const console = new Console({
      comm: mockComm,
      builtinCtx: { comm: undefined, config: { config: { max_tool_calls_per_prompt: 50 }, roles: {} } as any, ledger: { totalUsd: 0, turnLine: () => "" } as any, workflows: [], recentLines: () => [], queuedPrompt: () => undefined },
      out: (text: string) => { lines.push(text); },
      notice: () => {},
      isTty: false,
      turnActive: () => true,
      autoContinue: false,
      onShutdown: () => {},
    });
    // TC-32: y → allow
    console.askUser({ kind: "pending", request_id: "pending_fx_1", effect_id: "fx_1", tool: "run_command", summary: "echo hello", reason: "SafeToAutoRun is false" });
    expect(lines).toContain("Approve run_command: echo hello? [y/n]\n");
    console.handleLine("y");
    expect(calls).toContain("fx_1:allow");
    // TC-33: n → deny
    calls.length = 0;
    lines.length = 0;
    console.askUser({ kind: "pending", request_id: "pending_fx_2", effect_id: "fx_2", tool: "run_command", summary: "echo world", reason: "SafeToAutoRun is false" });
    expect(lines).toContain("Approve run_command: echo world? [y/n]\n");
    console.handleLine("n");
    expect(calls).toContain("fx_2:deny");
    // Empty line → deny
    calls.length = 0;
    console.askUser({ kind: "pending", request_id: "pending_fx_3", effect_id: "fx_3", tool: "run_command", summary: "echo test", reason: "SafeToAutoRun is false" });
    console.handleLine("");
    expect(calls).toContain("fx_3:deny");
  }, 5000);

  test("TC-34: headless deny with NOTICE text; TC-35: --approve-all allows", async () => {
    const { answerHeadless } = await import("../../src/cli/headless.ts");
    type Communicator = InstanceType<typeof import("../../src/communicator/core.ts").Communicator>;
    const calls: string[] = [];
    const events: AgentEvent[] = [];
    const mockComm = {
      resolvePending: (effectId: string, decision: "allow" | "deny") => { calls.push(`${effectId}:${decision}`); },
      appendOwnEvent: (e: AgentEvent) => { events.push(e); },
    } as unknown as Communicator;
    // TC-34: headless without --approve-all → deny with NOTICE
    answerHeadless(mockComm, { kind: "pending", request_id: "pending_fx_1", effect_id: "fx_1", tool: "run_command", summary: "echo hello", reason: "SafeToAutoRun is false" }, false, false);
    expect(calls).toContain("fx_1:deny");
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("NOTICE: run_command 'echo' denied - headless mode has no approver; use --approve-all or SafeToAutoRun"))).toBe(true);
    // TC-35: headless with --approve-all → allow
    calls.length = 0;
    events.length = 0;
    answerHeadless(mockComm, { kind: "pending", request_id: "pending_fx_2", effect_id: "fx_2", tool: "run_command", summary: "echo hello", reason: "SafeToAutoRun is false" }, false, true);
    expect(calls).toContain("fx_2:allow");
    expect(events).toHaveLength(0);
  }, 5000);
});

describe("[blackbox] SECREMED U06 - passthrough banner and profile-change notice", () => {
  test("passthrough profile prints WARNING banner on stderr", async () => {
    const { proc } = rig("script_exec_basic.jsonl", { harness: { profile: "passthrough" } });
    const result = await proc.runHeadless("read the readme", { outputFormat: "jsonl", timeoutMs: 60000 });
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("WARNING: profile passthrough - no guards, no approvals");
  }, 90000);

  test("profile-change notice when previous session ran a different profile", async () => {
    const { proc, appDir } = rig("script_exec_basic.jsonl", { harness: { profile: "local" } });
    const r1 = await proc.runHeadless("read the readme", { outputFormat: "jsonl", timeoutMs: 60000 });
    expect(r1.code).toBe(0);
    const configPath2 = join(appDir, ".agent-data", "config", "agent-config-passthrough.json");
    writeFileSync(configPath2, JSON.stringify({ roles: { generating: { model_id: "glm-5.2", effort: "high" } }, agent_folder: FAKE_SYSTEM, ipc: { heartbeat_s: 1 }, harness: { profile: "passthrough" } }, null, 2));
    const r2 = await proc.runHeadless("read the readme", { outputFormat: "jsonl", timeoutMs: 60000, extraArgs: ["--config", configPath2] });
    expect(r2.code).toBe(0);
    expect(r2.stderr).toContain("NOTICE: profile changed");
  }, 120000);
});

describe("[blackbox] SECREMED U08 - SEC-001 CLI approval", () => {
  test("SEC-001 pipe mode: piped n → tool blocked 'denied by user'", async () => {
    const { proc, appDir } = rig("script_run_command.jsonl", { harness: { profile: "local" } });
    const handle = proc.startPiped([]);
    handle.send("run the command");
    // Wait for the approval prompt to appear
    await Bun.sleep(5000);
    const out = handle.stdout();
    expect(out).toContain("Approve run_command: echo hello? [y/n]");
    handle.send("n");
    // Wait for the turn to finish, then exit
    await Bun.sleep(5000);
    handle.send("/exit");
    const code = await handle.waitExit(30000);
    expect(code).toBe(0);
    const finalOut = handle.stdout();
    expect(finalOut).toContain("denied by user");
    const events = sessionEvents(appDir);
    expect(events.some((e) => e.type === "tool_call_finished" && (e as { status: string }).status === "blocked")).toBe(true);
  }, 90000);

  test("SEC-001 pipe mode: piped y → tool dispatched", async () => {
    const { proc } = rig("script_run_command.jsonl", { harness: { profile: "local" } });
    const handle = proc.startPiped([]);
    handle.send("run the command");
    await Bun.sleep(5000);
    const out = handle.stdout();
    expect(out).toContain("Approve run_command: echo hello? [y/n]");
    handle.send("y");
    // Wait for the turn to finish, then exit
    await Bun.sleep(5000);
    handle.send("/exit");
    const code = await handle.waitExit(30000);
    expect(code).toBe(0);
    const finalOut = handle.stdout();
    // After allow, the tool dispatches and the model produces its second response
    expect(finalOut).toContain("The command was executed.");
  }, 90000);

  test("SEC-001 headless: run_command pending → denied with NOTICE", async () => {
    const { proc, appDir } = rig("script_run_command.jsonl", { harness: { profile: "local" } });
    const result = await proc.runHeadless("run the command", { outputFormat: "jsonl", timeoutMs: 60000 });
    expect(result.code).toBe(0);
    const events = sessionEvents(appDir);
    // The tool_call_finished should be blocked
    const blocked = events.find((e) => e.type === "tool_call_finished" && (e as { status: string }).status === "blocked");
    expect(blocked).toBeDefined();
    expect((blocked as { result: string }).result).toContain("denied by user");
    // The NOTICE should appear in the session events
    expect(events.some((e) => e.type === "error" && (e as { message: string }).message.includes("denied - headless mode has no approver"))).toBe(true);
  }, 90000);

  test("SEC-001 headless --approve-all: run_command pending → allowed", async () => {
    const { proc, appDir } = rig("script_run_command.jsonl", { harness: { profile: "local" } });
    const result = await proc.runHeadless("run the command", { outputFormat: "jsonl", timeoutMs: 60000, extraArgs: ["--approve-all"] });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("WARNING: --approve-all: every pending effect is approved");
    const events = sessionEvents(appDir);
    const ok = events.find((e) => e.type === "tool_call_finished" && (e as { status: string }).status === "ok");
    expect(ok).toBeDefined();
  }, 90000);
});
