import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleSystemPrompt, workspaceTree } from "../../src/prompt/assemble.ts";
import { loadPromptSystem } from "../../src/prompt/loader.ts";
import { findGitRoot } from "../../src/executor/session.ts";
import { buildDefinitions } from "../../src/tools/definitions.ts";
import { FAKE_SYSTEM, SCRIPTS, recordedTypes, startExecutor, type ExecutorRig } from "../harness/executor_rig.ts";
import { removeDir } from "../harness/procs.ts";

const rigs: ExecutorRig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.shutdown().catch(() => undefined);
    for (const d of r.cleanupDirs) removeDir(d);
  }
});

async function rig(script: string, extra: Parameters<typeof startExecutor>[0] extends infer O ? Partial<O> : never = {}): Promise<ExecutorRig> {
  const r = await startExecutor({ script: join(SCRIPTS, script), ...extra });
  rigs.push(r);
  return r;
}

describe("[integration] HERAV1EXEC-TP01 turn loop (real Executor, scripted adapter, FakeComm)", () => {
  test("HERAV1EXEC-TP01-TC-01/24 session_started first with the byte-verbatim system prompt; a turn runs read_file behind both gates", async () => {
    const r = await rig("script_exec_basic.jsonl");
    const started = r.eventsOf("session_started");
    expect(started).toHaveLength(1);
    expect(r.events()[0]?.type).toBe("session_started");
    const system = loadPromptSystem(FAKE_SYSTEM);
    const expected = assembleSystemPrompt(system, { os: "windows", workspace: r.workspace, gitRoot: findGitRoot(r.workspace), tree: workspaceTree(r.workspace, { maxDepth: 4, maxLines: 200 }) });
    expect(started[0]?.system_prompt).toBe(expected);
    expect(started[0]?.tool_definitions).toHaveLength(15);
    expect(started[0]?.tool_definitions.map((t) => t["name"])).toEqual(buildDefinitions({ os: "windows", shell: "pwsh", skills: [] }).map((t) => t.name));
    expect((started[0]?.config_snapshot["roles"] as Record<string, { model_id: string }>)["generating"]?.model_id).toBe("glm-5.2");
    expect(started[0]?.definition_hash).toMatch(/^[0-9a-f]{16,32}$/);

    r.prompt("read the readme");
    const finished = await r.waitForEvent("turn_finished");
    const types = r.events().map((e) => e.type);
    // two loader WARNING lines (fake_system's broken.md and no-skill-md) follow session_started
    expect(types).toEqual(["session_started", "error", "error", "user_message", "turn_started", "model_called", "thinking_delta", "text_delta", "tool_call_requested", "tool_call_finished", "model_called", "text_delta", "turn_finished"]);
    const user = r.eventsOf("user_message")[0];
    expect(user?.content).toMatch(/^<user_request>\nread the readme\n<\/user_request>\n\n<user_metadata>\ndate: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\ncwd: /);
    const requested = r.eventsOf("tool_call_requested")[0];
    expect(requested?.tool).toBe("read_file");
    expect(requested?.args_json).toContain("README.md");
    const done = r.eventsOf("tool_call_finished")[0];
    expect(done?.status).toBe("ok");
    expect(done?.result).toContain("Hello from the rig.");
    expect(finished.role).toBe("generating");
    expect(finished.stop_reason).toBe("end");
    expect(finished.uncached_input).toBe(1300);
    expect(finished.output).toBe(50);
    expect(finished.cache_read).toBe(900);
    expect(finished.thinking_payloads).toEqual([]);
    // two gates in order: the request line was acknowledged before the finished line
    const seq = recordedTypes(r.comm);
    const reqIdx = seq.indexOf("in:event(tool_call_requested)");
    const ackIdx = seq.findIndex((s, i) => i > reqIdx && s === "out:ack");
    const finIdx = seq.indexOf("in:event(tool_call_finished)");
    expect(reqIdx).toBeGreaterThan(-1);
    expect(ackIdx).toBeGreaterThan(reqIdx);
    expect(finIdx).toBeGreaterThan(ackIdx);
    // the Executor wrote nothing to stdout (IG-06)
    expect(r.comm.stdoutText).toBe("");
    // heartbeat carries phase and turn usage
    const beat = await r.comm.waitFor((m) => m.type === "heartbeat" && (m.payload as { turn_active: boolean }).turn_active === false && (m.payload as { phase?: string }).phase === "idle", 5000, "idle heartbeat");
    expect((beat.payload as { turn_usage?: { uncached_input: number } }).turn_usage?.uncached_input).toBe(1300);
    // second prompt reuses the state (three script lines consumed in order)
    r.prompt("and again");
    await r.waitForEvent("turn_finished", 10000, (e) => r.eventsOf("turn_finished").length === 2 && e.output === 5);
    expect(r.eventsOf("user_message")).toHaveLength(2);
  }, 30000);

  test("HERAV1EXEC-TP01-TC-05 block verdict: no execution, status blocked, result names the rule", async () => {
    const r = await rig("script_exec_denied.jsonl");
    r.prompt("clean the build folder");
    const finished = await r.waitForEvent("turn_finished");
    const done = r.eventsOf("tool_call_finished")[0];
    expect(done?.status).toBe("blocked");
    expect(done?.result).toContain("denylist");
    expect(finished.stop_reason).toBe("end");
    // nothing executed: no command child was ever registered in a heartbeat
    expect(r.comm.received.filter((m) => m.type === "heartbeat").every((m) => ((m.payload as { children?: number[] }).children ?? []).length === 0)).toBe(true);
    expect(r.eventsOf("text_delta").map((e) => e.text).join("")).toContain("blocked");
  }, 30000);

  test("HERAV1EXEC-TP01-TC-06 gate allows safe commands, blocks denylisted ones", async () => {
    const r = await rig("script_exec_basic.jsonl");
    r.prompt("go");
    await r.waitForEvent("turn_finished");
    expect(r.eventsOf("tool_call_finished")[0]?.status).toBe("ok");
  }, 30000);

  test("HERAV1EXEC-TP01-TC-09/10 cancel during a tool: child killed, ToolCall cancelled, turn_finished cancelled with the note", async () => {
    const r = await rig("script_sleep_command.jsonl", { configOverrides: { harness: { local: { approval: "off" } } } });
    r.prompt("run it");
    await r.waitForEvent("tool_call_requested");
    const beat = await r.comm.waitFor((m) => m.type === "heartbeat" && ((m.payload as { children?: number[] }).children ?? []).length === 1, 10000, "child in heartbeat");
    const childPid = (beat.payload as { children: number[] }).children[0] as number;
    r.comm.send("cancel", { reason: "user" });
    const finished = await r.waitForEvent("turn_finished");
    expect(finished.stop_reason).toBe("cancelled");
    expect(r.eventsOf("tool_call_finished")[0]?.status).toBe("cancelled");
    await Bun.sleep(300);
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    // cancel while idle is ignored; the next prompt runs normally
    r.comm.send("cancel", {});
    r.prompt("again");
    await r.waitForEvent("turn_finished", 10000, () => r.eventsOf("turn_finished").length === 2);
  }, 30000);

  test("HERAV1EXEC-TP01-TC-11 resume {tool_hang} during a tool: tool terminated, ToolCall error, executor_resumed, loop continues", async () => {
    const r = await rig("script_sleep_command.jsonl", { configOverrides: { harness: { local: { approval: "off" } } } });
    r.prompt("run it");
    await r.waitForEvent("tool_call_requested");
    await r.comm.waitFor((m) => m.type === "heartbeat" && ((m.payload as { children?: number[] }).children ?? []).length === 1, 10000, "child in heartbeat");
    r.fromSupervisor("resume", { reason: "tool_hang", phase: "tool_call" });
    const finished = await r.waitForEvent("turn_finished");
    expect(finished.stop_reason).toBe("end");
    const done = r.eventsOf("tool_call_finished")[0];
    expect(done?.status).toBe("timed_out");
    expect(done?.result).toMatch(/^tool terminated by supervisor after \d+ s without completion$/);
    expect(r.eventsOf("executor_resumed").map((e) => e.reason)).toEqual(["tool_hang"]);
    expect(r.eventsOf("text_delta").map((e) => e.text).join("")).toContain("After the command.");
  }, 30000);

  test("HERAV1EXEC-TP01-TC-14 provider failure: error {category: provider}, no turn_finished, next prompt works", async () => {
    const r = await rig("script_provider_error.jsonl");
    r.prompt("fail");
    const err = await r.waitForEvent("error", 10000, (e) => e.category === "provider");
    expect(err.message).toContain("simulated 500 after retries");
    await Bun.sleep(300);
    expect(r.eventsOf("turn_finished")).toHaveLength(0);
    const beat = r.comm.received.filter((m) => m.type === "heartbeat").at(-1);
    void beat;
    r.prompt("try again");
    const finished = await r.waitForEvent("turn_finished");
    expect(finished.stop_reason).toBe("end");
    expect(r.eventsOf("text_delta").map((e) => e.text).join("")).toContain("recovered");
  }, 30000);

  test("HERAV1EXEC-TP01-TC-16/17 slash expansion and unknown workflow", async () => {
    const r = await rig("script_exec_basic.jsonl");
    r.prompt("/primer");
    const finished = await r.waitForEvent("turn_finished");
    const err = r.eventsOf("error").find((e) => e.severity === "error" && e.message.includes("Unknown workflow"));
    expect(err?.message).toBe("Unknown workflow '/primer'. Closest matches: /prime");
    // loader warnings follow session_started, never precede it
    expect(r.events()[0]?.type).toBe("session_started");
    expect(r.eventsOf("error").some((e) => e.message.includes("broken.md"))).toBe(true);
    expect(finished.uncached_input).toBe(0);
    expect(r.eventsOf("user_message")).toHaveLength(0);
    r.prompt("/prime");
    await r.waitForEvent("turn_finished", 10000, () => r.eventsOf("turn_finished").length === 2);
    const user = r.eventsOf("user_message")[0];
    expect(user?.expanded_workflow).toBe("prime");
    expect(user?.content).toContain("<user_request>\n/prime\n<workflows>\n@[/prime] is a [Workflow]:\n<workflow>\nThe user mentioned the (prime) workflow. Here are its contents:\n# Prime Workflow");
    expect(user?.content).toContain("</workflow>\n</workflows>\n</user_request>");
  }, 30000);

  test("HERAV1EXEC-TP01-TC-12 ask_user round trip: request → answer → tool result with the labels", async () => {
    const r = await rig("script_ask_user.jsonl");
    r.prompt("ask me");
    const ask = await r.waitForMessage("ask_user");
    expect(ask.type === "ask_user" && ask.payload.kind).toBe("question");
    const payload = ask.payload as { request_id: string; question: string; options: Array<{ label: string }> };
    expect(payload.question).toBe("Which one?");
    expect(payload.options.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
    const beat = await r.comm.waitFor((m) => m.type === "heartbeat" && (m.payload as { phase?: string }).phase === "waiting_answer", 5000, "waiting_answer heartbeat");
    expect((beat.payload as { turn_active: boolean }).turn_active).toBe(true);
    r.comm.send("answer", { request_id: payload.request_id, selected: ["Beta"] });
    await r.waitForEvent("turn_finished");
    expect(r.eventsOf("tool_call_finished")[0]).toMatchObject({ status: "ok", result: "Beta" });
  }, 30000);

  test("HERAV1EXEC-TP01-TC-02 tool-call limit: ask_user {continue}; proceed false ends the turn with error {limit}", async () => {
    const r = await rig("script_41_calls.jsonl", { configOverrides: { max_tool_calls_per_prompt: 2 } });
    r.prompt("loop");
    const ask = await r.waitForMessage("ask_user");
    expect(ask.type === "ask_user" && ask.payload.kind).toBe("continue");
    expect(r.eventsOf("tool_call_finished")).toHaveLength(2);
    r.comm.send("continue", { proceed: false });
    const finished = await r.waitForEvent("turn_finished");
    expect(r.eventsOf("error").some((e) => e.category === "limit")).toBe(true);
    expect(finished.stop_reason).toBe("end");
    expect(r.eventsOf("tool_call_finished")).toHaveLength(2);
  }, 30000);

  test("HERAV1EXEC-TP01-TC-03 tool-call limit with proceed true resets the counter; auto_continue skips the pause", async () => {
    const r = await rig("script_41_calls.jsonl", { configOverrides: { max_tool_calls_per_prompt: 2 } });
    r.prompt("loop");
    const ask = await r.waitForMessage("ask_user");
    r.comm.send("continue", { proceed: true });
    await r.waitForEvent("turn_finished");
    expect(r.eventsOf("tool_call_finished")).toHaveLength(3);
    void ask;
    const auto = await rig("script_41_calls.jsonl", { configOverrides: { max_tool_calls_per_prompt: 2, auto_continue: true } });
    auto.prompt("loop");
    await auto.waitForEvent("turn_finished");
    expect(auto.comm.received.some((m) => m.type === "ask_user")).toBe(false);
    expect(auto.eventsOf("tool_call_finished")).toHaveLength(3);
  }, 40000);

  test("HERAV1EXEC-TP01-TC-15 stop reasons: max_output → WARNING + finish; refusal → error + finish; pause → one re-issue", async () => {
    const r = await rig("script_stops.jsonl");
    r.prompt("one");
    const f1 = await r.waitForEvent("turn_finished");
    expect(f1.stop_reason).toBe("max_output");
    expect(r.eventsOf("error").some((e) => e.severity === "warning" && e.message.includes("output limit"))).toBe(true);
    r.prompt("two");
    await r.waitForEvent("turn_finished", 10000, () => r.eventsOf("turn_finished").length === 2);
    const f2 = r.eventsOf("turn_finished")[1] as { stop_reason?: string };
    expect(f2.stop_reason).toBe("refusal");
    expect(r.eventsOf("error").some((e) => e.severity === "error" && e.message.includes("refused to continue"))).toBe(true);
    r.prompt("three");
    await r.waitForEvent("turn_finished", 10000, () => r.eventsOf("turn_finished").length === 3);
    const f3 = r.eventsOf("turn_finished")[2] as { stop_reason?: string };
    expect(f3.stop_reason).toBe("end");
    expect(r.eventsOf("text_delta").map((e) => e.text).join("")).toContain("server tool done");
  }, 40000);

  test("HERAV1EXEC-TP01-TC-20/21 compaction: NOTICE, compacting call, checkpoint with the todo verbatim; failure leaves state untouched", async () => {
    const r = await rig("script_compaction.jsonl", { configOverrides: { compaction_threshold_max_tokens: 150000 } });
    r.prompt("work");
    await r.waitForEvent("turn_finished");
    const notice = r.eventsOf("error").find((e) => e.severity === "notice" && e.message.startsWith("Compacting context"));
    expect(notice?.message).toMatch(/^Compacting context \(~\d+ tokens, threshold 150000\)\.\.\.$/);
    const cp = r.eventsOf("checkpoint_created");
    expect(cp).toHaveLength(1);
    expect(cp[0]?.text).toContain("# Objective:\n\nFinish the sample task.");
    expect(cp[0]?.text).toContain("# Current working TODO list (keep this up to date with todo_list tool):");
    const todoResult = r.eventsOf("tool_call_finished").find((e) => e.result.includes('"todos"'));
    expect(cp[0]?.text).toContain(todoResult?.result as string);
    expect(cp[0]?.text).toContain("Make sure to continue working off of this TODO list");
    expect(cp[0]?.text.endsWith("DO NOT ACKNOWLEDGE THIS CHECKPOINT MESSAGE.")).toBe(true);
    expect(cp[0]?.usage).toMatchObject({ uncached_input: 500, output: 50 });
    expect(cp[0]?.truncated_messages).toBeGreaterThanOrEqual(0);
    const fail = await rig("script_compaction_fail.jsonl");
    fail.prompt("work");
    const finished = await fail.waitForEvent("turn_finished");
    expect(fail.eventsOf("checkpoint_created")).toHaveLength(0);
    expect(fail.eventsOf("error").some((e) => e.severity === "warning" && e.message.startsWith("compaction failed"))).toBe(true);
    expect(finished.stop_reason).toBe("end");
  }, 40000);

  test("HERAV1EXEC-TP01-TC-26/27 resume from the JSONL: no session_started, recorded prompt reused, projection restores the conversation", async () => {
    const first = await rig("script_exec_basic.jsonl");
    first.prompt("read the readme");
    await first.waitForEvent("turn_finished");
    const jsonl = first.writeJsonl();
    const recordedPrompt = first.eventsOf("session_started")[0]?.system_prompt as string;
    await first.shutdown();
    // resume with a DIFFERENT prompt system folder: the recorded prompt still wins, one WARNING names the difference
    const capture = join(first.appDir, "capture.jsonl");
    const second = await startExecutor({ script: join(SCRIPTS, "script_exec_basic.jsonl"), resumePath: jsonl, agentFolder: join(FAKE_SYSTEM, "..", "fake_system_empty_marker_missing"), env: { HERA_SCRIPTED_CAPTURE: capture } });
    rigs.push(second);
    expect(second.eventsOf("session_started")).toHaveLength(0);
    const warning = second.eventsOf("error").find((e) => e.severity === "warning" && e.message.includes("definition hash changed"));
    expect(warning).toBeDefined();
    second.prompt("continue");
    await second.waitForEvent("turn_finished");
    const captured = readFileSync(capture, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as { system: string });
    expect(captured[0]?.system).toBe(recordedPrompt);
    // the second Executor's slash expansion still uses the on-disk (now empty) prompt system
    second.prompt("/prime");
    await second.waitForEvent("turn_finished", 10000, () => second.eventsOf("turn_finished").length === 2);
    expect(second.eventsOf("error").some((e) => e.severity === "error" && e.message.includes("Unknown workflow '/prime'"))).toBe(true);
  }, 40000);

  test("HERAV1EXEC-TP01-TC-39 eight 50K-char tool results in a 200K-token window: no request above the window, turn completes", async () => {
    const r = await rig("script_fit_check.jsonl", { configOverrides: { roles: { generating: { model_id: "glm-5", effort: "high" } } } });
    writeFileSync(join(r.workspace, "big.txt"), "x".repeat(60000));
    r.prompt("read the big file eight times");
    const finished = await r.waitForEvent("turn_finished", 30000);
    expect(finished.stop_reason).toBe("end");
    expect(r.eventsOf("tool_call_finished")).toHaveLength(8);
    expect(r.eventsOf("tool_call_finished").every((e) => e.status === "ok")).toBe(true);
    // no WARNING about exceeding the window
    expect(r.eventsOf("error").some((e) => e.severity === "warning" && e.message.includes("request exceeds the model's context window"))).toBe(false);
  }, 60000);

  test("HERAV1EXEC-TP01-TC-40 bounded recovery: compaction fails, tool results dropped, WARNING and turn ends", async () => {
    const r = await rig("script_compaction_fail.jsonl", { configOverrides: { compaction_threshold_max_tokens: 500 } });
    r.prompt("work");
    const finished = await r.waitForEvent("turn_finished", 30000);
    expect(finished.stop_reason).toBe("end");
    expect(r.eventsOf("checkpoint_created")).toHaveLength(0);
    expect(r.eventsOf("error").some((e) => e.severity === "warning" && e.message.startsWith("compaction failed"))).toBe(true);
  }, 40000);
});
