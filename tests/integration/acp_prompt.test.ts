import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonlFile, type AgentEvent } from "../../src/events.ts";
import { AcpClient, assertStdoutPure, type JsonRpcMessage } from "../harness/acp_client.ts";
import { assertNoSecretLeak } from "../harness/assertions.ts";
import { FAKE_SYSTEM, SCRIPTS, prepareRig } from "../harness/executor_rig.ts";
import { removeDir } from "../harness/procs.ts";
import { SchemaOracle } from "../harness/schema_validate.ts";

const DECOY = "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789";
const clients: AcpClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  for (const d of dirs.splice(0)) removeDir(d);
});
const oracle = new SchemaOracle();

function rig(script: string, opts: { capabilities?: "full" | "bare"; configOverrides?: Record<string, unknown>; extraArgs?: string[] } = {}): { client: AcpClient; appDir: string; workspace: string } {
  const prepared = prepareRig({ script: join(SCRIPTS, script), agentFolder: FAKE_SYSTEM, configOverrides: { supervisor: { review_every_calls: 50, cost_alert_usd: 100 }, ...(opts.configOverrides ?? {}) } });
  dirs.push(...prepared.dirs);
  const client = new AcpClient({ workspace: prepared.workspace, appDir: prepared.appDir, scriptPath: prepared.env["HERA_SCRIPTED_ADAPTER"] as string, capabilities: opts.capabilities ?? "full", extraArgs: opts.extraArgs, env: { HERA_DECOY_KEY: DECOY } }).start();
  clients.push(client);
  return { client, appDir: prepared.appDir, workspace: prepared.workspace };
}

async function openSession(client: AcpClient): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.handshake();
      const { sessionId } = await client.sessionNew();
      await client.readMessage(); // available_commands_update
      return sessionId;
    } catch (e) {
      if (attempt < 2 && e instanceof Error && e.message.includes("hera exited")) {
        await Bun.sleep(500);
        client.restart();
        continue;
      }
      throw e;
    }
  }
}

const sessionEvents = (appDir: string, sessionId: string): AgentEvent[] => readJsonlFile(join(appDir, ".agent-data", "sessions", `${sessionId}.jsonl`)).events;
const isUpdate = (m: JsonRpcMessage, kind: string): boolean => m.method === "session/update" && (m.params as { update: { sessionUpdate: string } }).update.sessionUpdate === kind;

describe("[integration] HERAV1ACP-TP01 prompt turns", () => {
  test("HERAV1ACP-IP01-TC-19 scripted turn: chunks share the messageId, thought chunk, tool_call before tool_call_update, usage_update, {stopReason: end_turn}; stdout pure and schema-valid", async () => {
    const { client } = rig("script_exec_basic.jsonl");
    const sessionId = await openSession(client);
    const { response, collected } = await client.request("session/prompt", AcpClient.promptParams(sessionId, "read the readme"));
    expect(response.result).toEqual({ stopReason: "end_turn" });
    const updates = AcpClient.updates(collected);
    const chunks = updates.filter((u) => u["sessionUpdate"] === "agent_message_chunk");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c["messageId"] === chunks[0]?.["messageId"])).toBe(true);
    expect(chunks.map((c) => (c["content"] as { text: string }).text).join("")).toBe("Reading the README.The README says hello from the rig.");
    const thoughts = updates.filter((u) => u["sessionUpdate"] === "agent_thought_chunk");
    expect(thoughts[0]).toMatchObject({ messageId: chunks[0]?.["messageId"], content: { type: "text", text: "Read the readme first." } });
    const toolCall = updates.findIndex((u) => u["sessionUpdate"] === "tool_call");
    const toolUpdate = updates.findIndex((u) => u["sessionUpdate"] === "tool_call_update");
    expect(toolCall).toBeLessThan(toolUpdate);
    expect(updates[toolCall]).toMatchObject({ kind: "read", status: "pending", title: expect.stringMatching(/^read_file: /) });
    expect(updates[toolUpdate]).toMatchObject({ status: "completed", toolCallId: updates[toolCall]?.["toolCallId"] });
    const usage = updates.filter((u) => u["sessionUpdate"] === "usage_update");
    expect(usage.at(-1)).toMatchObject({ used: 2250, cost: { currency: "USD" } });
    expect((usage.at(-1) as { size: number }).size).toBeGreaterThan(0);
    assertStdoutPure(client);
    for (const line of client.rawStdout) {
      const msg = JSON.parse(line) as { method?: string; params?: unknown };
      if (msg.method === "session/update") oracle.assertValid("SessionNotification", msg.params);
    }
    assertNoSecretLeak([client.rawStdout.join("\n"), client.stderr()], undefined, [DECOY]);
  }, 40000);

  test("HERAV1ACP-IP01-TC-18 text + resource_link accepted and flattened into the user message; image → -32602 naming the type; empty prompt → -32602", async () => {
    const { client, appDir } = rig("script_exec_basic.jsonl");
    const sessionId = await openSession(client);
    const image = await client.request("session/prompt", { sessionId, prompt: [{ type: "image", data: "...", mimeType: "image/png" }] });
    expect(image.response.error).toMatchObject({ code: -32602, message: expect.stringContaining("'image'") });
    const empty = await client.request("session/prompt", { sessionId, prompt: [] });
    expect(empty.response.error?.code).toBe(-32602);
    const { response } = await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Analyze this file" }, { type: "resource_link", uri: "file:///proj/main.py", name: "main.py" }] });
    expect(response.result).toEqual({ stopReason: "end_turn" });
    const user = sessionEvents(appDir, sessionId).find((e) => e.type === "user_message") as { content: string };
    expect(user.content).toContain("Analyze this file");
    expect(user.content).toContain("[resource: main.py](file:///proj/main.py)");
  }, 40000);

  test("HERAV1ACP-IP01-TC-20 denylisted run_command: tool_call pending, tool_call_update failed with the block text, and NO session/request_permission", async () => {
    const { client } = rig("script_exec_denied.jsonl");
    const sessionId = await openSession(client);
    const { response, collected } = await client.request("session/prompt", AcpClient.promptParams(sessionId, "clean the build folder"));
    expect(response.result).toEqual({ stopReason: "end_turn" });
    expect(collected.some((m) => m.method === "session/request_permission")).toBe(false);
    const updates = AcpClient.updates(collected);
    expect(updates.find((u) => u["sessionUpdate"] === "tool_call")).toMatchObject({ kind: "execute", status: "pending", title: "run_command: rm -rf build" });
    const failed = updates.find((u) => u["sessionUpdate"] === "tool_call_update") as { status: string; content: Array<{ content: { text: string } }> };
    expect(failed.status).toBe("failed");
    expect(failed.content[0]?.content.text).toMatch(/^blocked by denylist/);
    expect(client.stderr()).not.toMatch(/approv/i);
  }, 40000);

  test("HERAV1ACP-IP01-TC-21 tool-call limit → session/request_permission on continue_<n> with allow_once/reject_once; allow continues, reject ends the turn", async () => {
    const allow = rig("script_41_calls.jsonl", { configOverrides: { max_tool_calls_per_prompt: 2 } });
    allow.client.autoResponders.set("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }));
    const s1 = await openSession(allow.client);
    const first = await allow.client.request("session/prompt", AcpClient.promptParams(s1, "loop"));
    const permissions = first.collected.filter((m) => m.method === "session/request_permission");
    expect(permissions.length).toBeGreaterThanOrEqual(1);
    expect((permissions[0]?.params as { toolCall: { toolCallId: string } }).toolCall.toolCallId).toMatch(/^continue_\d+$/);
    expect((permissions[0]?.params as { options: Array<{ kind: string }> }).options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    for (const p of permissions) oracle.assertValid("RequestPermissionRequest", p.params);
    expect(first.response.result).toEqual({ stopReason: "end_turn" });
    expect(AcpClient.updates(first.collected, "tool_call_update").length).toBe(3);
    const reject = rig("script_41_calls.jsonl", { configOverrides: { max_tool_calls_per_prompt: 2 } });
    reject.client.autoResponders.set("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "reject-once" } }));
    const s2 = await openSession(reject.client);
    const second = await reject.client.request("session/prompt", AcpClient.promptParams(s2, "loop"));
    expect(second.response.result).toEqual({ stopReason: "end_turn" });
    expect(AcpClient.updates(second.collected, "tool_call_update").length).toBe(2);
    expect(second.collected.filter((m) => m.method === "session/request_permission").length).toBe(1);
  }, 60000);

  test("HERAV1ACP-IP01-TC-38 gate pending → session/request_permission on the tool call; client allow → tool dispatched; client reject → blocked: denied by user", async () => {
    const allow = rig("script_run_command.jsonl");
    allow.client.autoResponders.set("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }));
    const s1 = await openSession(allow.client);
    const first = await allow.client.request("session/prompt", AcpClient.promptParams(s1, "run it"));
    const permissions = first.collected.filter((m) => m.method === "session/request_permission");
    expect(permissions.length).toBe(1);
    expect((permissions[0]?.params as { toolCall: { toolCallId: string; title: string } }).toolCall.title).toBe("echo hello");
    for (const p of permissions) oracle.assertValid("RequestPermissionRequest", p.params);
    expect(first.response.result).toEqual({ stopReason: "end_turn" });
    const allowUpdates = AcpClient.updates(first.collected, "tool_call_update");
    expect(allowUpdates[0] as { status: string }).toMatchObject({ status: "completed" });

    const reject = rig("script_run_command.jsonl");
    reject.client.autoResponders.set("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "reject-once" } }));
    const s2 = await openSession(reject.client);
    const second = await reject.client.request("session/prompt", AcpClient.promptParams(s2, "run it"));
    expect(second.response.result).toEqual({ stopReason: "end_turn" });
    const rejectUpdates = AcpClient.updates(second.collected, "tool_call_update");
    expect((rejectUpdates[0] as { status: string }).status).toBe("failed");
    expect(((rejectUpdates[0] as { content: Array<{ content: { text: string } }> }).content[0]?.content.text)).toContain("denied by user");
    assertStdoutPure(reject.client);
  }, 60000);

  test("HERAV1ACP-IP01-TC-22 ask_user_question: elicitation/create form with enum, accept → label in the tool result; bare client → fallback text without a wire request", async () => {
    const full = rig("script_ask_user.jsonl", { capabilities: "full" });
    full.client.autoResponders.set("elicitation/create", () => ({ action: "accept", content: { answer: "Beta" } }));
    const s1 = await openSession(full.client);
    const { response, collected } = await full.client.request("session/prompt", AcpClient.promptParams(s1, "ask me"));
    expect(response.result).toEqual({ stopReason: "end_turn" });
    const elicitation = collected.find((m) => m.method === "elicitation/create");
    expect(elicitation?.params).toMatchObject({ sessionId: s1, mode: "form", message: "Which one?", requestedSchema: { properties: { answer: { enum: ["Alpha", "Beta"] } }, required: ["answer"] } });
    oracle.assertValid("CreateElicitationRequest", elicitation?.params);
    const result = AcpClient.updates(collected, "tool_call_update")[0] as { status: string; content: Array<{ content: { text: string } }> };
    expect(result.status).toBe("completed");
    expect(result.content[0]?.content.text).toBe("Beta");
    const bare = rig("script_ask_user.jsonl", { capabilities: "bare" });
    const s2 = await openSession(bare.client);
    const fallback = await bare.client.request("session/prompt", AcpClient.promptParams(s2, "ask me"));
    expect(fallback.collected.some((m) => m.method === "elicitation/create")).toBe(false);
    const text = (AcpClient.updates(fallback.collected, "tool_call_update")[0] as { content: Array<{ content: { text: string } }> }).content[0]?.content.text;
    expect(text).toContain("does not support structured questions");
  }, 60000);

  test("HERAV1ACP-IP01-TC-23 /status and /cost as prompt text: one chunk + end_turn without an Executor turn; /help is forwarded", async () => {
    const { client, appDir } = rig("script_exec_basic.jsonl");
    const sessionId = await openSession(client);
    const status = await client.request("session/prompt", AcpClient.promptParams(sessionId, "/status"));
    expect(status.response.result).toEqual({ stopReason: "end_turn" });
    const chunks = AcpClient.updates(status.collected, "agent_message_chunk");
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { content: { text: string } }).content.text).toContain("Turn: idle");
    const cost = await client.request("session/prompt", AcpClient.promptParams(sessionId, "/cost"));
    expect((AcpClient.updates(cost.collected, "agent_message_chunk")[0] as { content: { text: string } }).content.text).toContain("Session total");
    expect(sessionEvents(appDir, sessionId).some((e) => e.type === "turn_finished")).toBe(false);
    // /help is not a Communicator built-in in ACP mode: forwarded, the Executor answers with the closest workflow matches
    const help = await client.request("session/prompt", AcpClient.promptParams(sessionId, "/help"));
    expect(help.response.result).toEqual({ stopReason: "end_turn" });
    expect(sessionEvents(appDir, sessionId).some((e) => e.type === "turn_finished" && e.proc === "exec")).toBe(true);
    const helpText = AcpClient.updates(help.collected, "agent_message_chunk").map((u) => (u["content"] as { text: string }).text).join("");
    expect(helpText).toContain("Unknown workflow '/help'");
  }, 40000);

  test("HERAV1ACP-IP01-TC-24 provider error → JSON-RPC error on the prompt id; a second prompt during a turn → error; after completion → accepted", async () => {
    const failing = rig("script_provider_error.jsonl");
    const s1 = await openSession(failing.client);
    const { response } = await failing.client.request("session/prompt", AcpClient.promptParams(s1, "go"));
    expect(response.error).toBeDefined();
    expect(response.error?.message).toMatch(/provider|rate|error/i);
    const slow = rig("script_sleep_more.jsonl", { configOverrides: { harness: { local: { approval: "off" } } } });
    const s2 = await openSession(slow.client);
    const firstId = slow.client.sendRequest("session/prompt", AcpClient.promptParams(s2, "run it"));
    await slow.client.readUntil((m) => isUpdate(m, "tool_call"));
    const second = await slow.client.request("session/prompt", AcpClient.promptParams(s2, "second"));
    expect(second.response.error?.message).toContain("already active");
    const { match } = await slow.client.readUntil((m) => m.id === firstId, 20000);
    expect(match.result).toEqual({ stopReason: "end_turn" });
    const third = await slow.client.request("session/prompt", AcpClient.promptParams(s2, "third"));
    expect(third.response.result).toEqual({ stopReason: "end_turn" });
  }, 60000);
});

describe("[integration] HERAV1ACP-TP01 cancellation, crash, purity", () => {
  test("HERAV1ACP-IP01-TC-25/26 session/cancel during a slow tool → cancel to the Executor, {stopReason: cancelled} without waiting; cancel with no turn is a no-op; $/cancel_request → -32800", async () => {
    const { client, appDir } = rig("script_sleep_command.jsonl", { configOverrides: { harness: { local: { approval: "off" } } } });
    const sessionId = await openSession(client);
    client.notify("session/cancel", { sessionId });
    await Bun.sleep(200);
    expect(client.stderr()).toContain("no active turn");
    client.notify("$/cancel_request", { requestId: 4711 });
    const promptId = client.sendRequest("session/prompt", AcpClient.promptParams(sessionId, "run it"));
    await client.readUntil((m) => isUpdate(m, "tool_call"));
    const started = performance.now();
    client.notify("session/cancel", { sessionId });
    const { match } = await client.readUntil((m) => m.id === promptId, 20000);
    expect(match.result).toEqual({ stopReason: "cancelled" });
    expect(performance.now() - started).toBeLessThan(10000);
    const events = sessionEvents(appDir, sessionId);
    expect(events.some((e) => e.type === "turn_finished" && (e as { stop_reason: string }).stop_reason === "cancelled")).toBe(true);
    expect(client.stderr()).toContain("no cancellable request with id 4711");
    // $/cancel_request on the active prompt id → -32800 (fresh rig: the sleep script has one tool turn)
    const other = rig("script_sleep_command.jsonl", { configOverrides: { harness: { local: { approval: "off" } } } });
    const s2 = await openSession(other.client);
    const second = other.client.sendRequest("session/prompt", AcpClient.promptParams(s2, "again"));
    await other.client.readUntil((m) => isUpdate(m, "tool_call"));
    other.client.notify("$/cancel_request", { requestId: second });
    const cancelled = await other.client.readUntil((m) => m.id === second, 20000);
    expect(cancelled.match.error?.code).toBe(-32800);
  }, 60000);

  test("HERAV1ACP-IP01-TC-26 cancel with a pending elicitation: the client request resolves cancelled, the tool result is cancelled, the prompt answers cancelled", async () => {
    const { client } = rig("script_ask_user.jsonl", { capabilities: "full" });
    const sessionId = await openSession(client);
    const promptId = client.sendRequest("session/prompt", AcpClient.promptParams(sessionId, "ask me"));
    const { match: elicitation } = await client.readUntil((m) => m.method === "elicitation/create");
    client.notify("session/cancel", { sessionId });
    const { match } = await client.readUntil((m) => m.id === promptId, 20000);
    expect(match.result).toEqual({ stopReason: "cancelled" });
    // answering the stale elicitation later is ignored with a stderr note, never an error on the wire
    client.send({ id: elicitation.id, result: { action: "accept", content: { answer: "Alpha" } } });
    await Bun.sleep(200);
    expect(client.stderr()).toContain(`unknown request id ${String(elicitation.id)}`);
    assertStdoutPure(client);
  }, 40000);

  test("HERAV1ACP-IP01-TC-28 Executor killed mid-prompt: WARNING chunk, executor resumed chunk, the same pending prompt completes with end_turn", async () => {
    const { client } = rig("script_sleep_short.jsonl", { configOverrides: { harness: { local: { approval: "off" } } } });
    const sessionId = await openSession(client);
    const status = await client.request("session/prompt", AcpClient.promptParams(sessionId, "/status"));
    const pid = Number(/executor\s+pid='(\d+)'/.exec((AcpClient.updates(status.collected, "agent_message_chunk")[0] as { content: { text: string } }).content.text)?.[1]);
    expect(pid).toBeGreaterThan(0);
    const promptId = client.sendRequest("session/prompt", AcpClient.promptParams(sessionId, "run it"));
    await client.readUntil((m) => isUpdate(m, "tool_call"));
    process.kill(pid, "SIGKILL");
    const { match, seen } = await client.readUntil((m) => m.id === promptId, 30000);
    expect(match.result).toEqual({ stopReason: "end_turn" });
    const texts = AcpClient.updates(seen, "agent_message_chunk").map((u) => (u["content"] as { text: string }).text);
    expect(texts.some((t) => /executor exited/.test(t))).toBe(true);
    expect(texts.some((t) => t === "NOTICE: executor resumed (restart)")).toBe(true);
    assertStdoutPure(client);
  }, 60000);

  test("HERAV1ACP-IP01-TC-30/31 full scripted session with --log-dir: stdout is JSON-RPC only (byte check), diagnostics on stderr, omissions logged for compaction", async () => {
    const prepared = prepareRig({ script: join(SCRIPTS, "script_compaction.jsonl"), agentFolder: FAKE_SYSTEM, configOverrides: { supervisor: { review_every_calls: 50, cost_alert_usd: 100 }, compaction_threshold_max_tokens: 200 } });
    dirs.push(...prepared.dirs);
    const appDir = prepared.appDir;
    const client = new AcpClient({ workspace: prepared.workspace, appDir, scriptPath: prepared.env["HERA_SCRIPTED_ADAPTER"] as string, capabilities: "full", extraArgs: ["--log-dir", join(appDir, "logs")], env: { HERA_DECOY_KEY: DECOY } }).start();
    clients.push(client);
    const sessionId = await openSession(client);
    const { response } = await client.request("session/prompt", AcpClient.promptParams(sessionId, "work"));
    expect(response.result ?? response.error).toBeDefined();
    client.closeStdin();
    expect(await client.waitExit()).toBe(0);
    // byte check: the whole stdout is a sequence of JSON-RPC lines and nothing else
    const raw = client.rawStdout;
    expect(raw.length).toBeGreaterThan(3);
    for (const line of raw) expect((JSON.parse(line) as { jsonrpc: string }).jsonrpc).toBe("2.0");
    expect(client.stderr().length).toBeGreaterThan(0);
    const events = sessionEvents(appDir, sessionId);
    if (events.some((e) => e.type === "checkpoint_created")) expect(client.stderr()).toContain("omitted: checkpoint_created");
    expect(readdirSync(join(appDir, "logs")).length).toBe(1);
    const log = readFileSync(join(appDir, "logs", readdirSync(join(appDir, "logs"))[0] as string), "utf8");
    expect(log).toContain('"dom":"acp","op":"recv"');
    expect(log).toContain('"dom":"acp","op":"turn"');
    assertNoSecretLeak([raw.join("\n"), client.stderr(), log], undefined, [DECOY]);
  }, 60000);
});

describe("[integration] U13 ACP pending rendering", () => {
  test("HERAV1ACP-IP01-TC-37 pending ask_user sends session/request_permission, not WARNING; client deny → blocked: denied by user", async () => {
    const { AcpServer } = await import("../../src/acp/server.ts");
    const { EventTranslator } = await import("../../src/acp/translator.ts");
    const { CostLedger } = await import("../../src/cli/cost.ts");
    type AcpConnection = InstanceType<typeof import("../../src/acp/connection.ts").AcpConnection>;
    type Communicator = InstanceType<typeof import("../../src/communicator/core.ts").Communicator>;

    const notified: Array<{ method: string; params: Record<string, unknown> }> = [];
    const requested: Array<{ method: string; params: Record<string, unknown> }> = [];
    const resolves: Array<{ id: string; decision: string }> = [];

    const mockConnection = {
      notify(method: string, params: Record<string, unknown>) { notified.push({ method, params }); },
      async request(method: string, params: Record<string, unknown>) { requested.push({ method, params }); return { outcome: { outcome: "selected", optionId: "reject-once" } }; },
      onRequest(_handler: unknown) {},
      onNotification(_handler: unknown) {},
      writer: { onOverflow: null as unknown as ((count: number) => void) | null },
      cancelPending(_reason: string) {},
      respondError(_id: unknown, _code: number, _message: string) {},
    };

    const mockComm = {
      sessionId: "test-session",
      get hasSession() { return true; },
      status() { return { turn: "idle" as const }; },
      cancel(_reason: string) {},
      answer(_payload: unknown) {},
      continueDecision(_proceed: boolean) {},
      submitPrompt(_text: string) {},
      appendOwnEvent(_event: unknown) {},
      resolvePending(id: string, decision: string) { resolves.push({ id, decision }); },
    };

    const ledger = new CostLedger({}, {} as Record<string, { provider: string; modelId: string }>);
    const translator = new EventTranslator({ ledger, contextWindow: 128000, stderr: () => undefined });

    const server = new AcpServer({
      connection: mockConnection as unknown as AcpConnection,
      comm: mockComm as unknown as Communicator,
      config: { roles: { generating: { contextWindow: 128000 } } } as any,
      ledger,
      workflows: [],
      stderr: () => undefined,
    });

    server.onAskUser({ kind: "pending", request_id: "pending_fx_1", effect_id: "fx_1", tool: "run_command", summary: "echo hello", reason: "pending: awaiting user decision" });

    await Bun.sleep(50);

    expect(requested.length).toBe(1);
    expect(requested[0]?.method).toBe("session/request_permission");
    expect((requested[0]?.params as { toolCall: { toolCallId: string } }).toolCall.toolCallId).toBe("");
    expect(notified.length).toBe(0);
    expect(resolves).toEqual([{ id: "fx_1", decision: "deny" }]);
  }, 10000);

  test("HERAV1ACP-IP01-TC-37b client error on permission request → deny + WARNING chunk", async () => {
    const { AcpServer } = await import("../../src/acp/server.ts");
    const { EventTranslator } = await import("../../src/acp/translator.ts");
    const { CostLedger } = await import("../../src/cli/cost.ts");
    type AcpConnection = InstanceType<typeof import("../../src/acp/connection.ts").AcpConnection>;
    type Communicator = InstanceType<typeof import("../../src/communicator/core.ts").Communicator>;

    const notified: Array<{ method: string; params: Record<string, unknown> }> = [];
    const resolves: Array<{ id: string; decision: string }> = [];

    const mockConnection = {
      notify(method: string, params: Record<string, unknown>) { notified.push({ method, params }); },
      async request(_method: string, _params: Record<string, unknown>) { throw new Error("method not found"); },
      onRequest(_handler: unknown) {},
      onNotification(_handler: unknown) {},
      writer: { onOverflow: null as unknown as ((count: number) => void) | null },
      cancelPending(_reason: string) {},
      respondError(_id: unknown, _code: number, _message: string) {},
    };

    const mockComm = {
      sessionId: "test-session",
      get hasSession() { return true; },
      status() { return { turn: "idle" as const }; },
      cancel(_reason: string) {},
      answer(_payload: unknown) {},
      continueDecision(_proceed: boolean) {},
      submitPrompt(_text: string) {},
      appendOwnEvent(_event: unknown) {},
      resolvePending(id: string, decision: string) { resolves.push({ id, decision }); },
    };

    const ledger = new CostLedger({}, {} as Record<string, { provider: string; modelId: string }>);
    const translator = new EventTranslator({ ledger, contextWindow: 128000, stderr: () => undefined });

    const server = new AcpServer({
      connection: mockConnection as unknown as AcpConnection,
      comm: mockComm as unknown as Communicator,
      config: { roles: { generating: { contextWindow: 128000 } } } as any,
      ledger,
      workflows: [],
      stderr: () => undefined,
    });

    server.onAskUser({ kind: "pending", request_id: "pending_fx_1", effect_id: "fx_1", tool: "run_command", summary: "echo hello", reason: "pending: awaiting user decision" });

    await Bun.sleep(50);

    expect(resolves).toEqual([{ id: "fx_1", decision: "deny" }]);
    expect(notified.length).toBe(1);
    expect(notified[0]?.method).toBe("session/update");
    const update = (notified[0]?.params as { update: { sessionUpdate: string; content: { text: string } } }).update;
    expect(update.sessionUpdate).toBe("agent_message_chunk");
    expect(update.content.text).toContain("WARNING");
  }, 10000);
});
