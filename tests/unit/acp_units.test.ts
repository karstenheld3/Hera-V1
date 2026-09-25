import { describe, expect, test } from "bun:test";
import { ContinueBroker, ElicitationBroker, NO_ELICITATION_FALLBACK, PermissionBroker, PERMISSION_OPTIONS } from "../../src/acp/brokers.ts";
import { AcpConnection, ClientErrorResponse, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR, RoundTripCancelled, WriteQueue, parseLine, toLine } from "../../src/acp/connection.ts";
import { assemblePromptText, initializeResult } from "../../src/acp/server.ts";
import { EventTranslator, TOOL_KINDS, todoPlan, type Update } from "../../src/acp/translator.ts";
import { CostLedger } from "../../src/cli/cost.ts";
import type { Communicator } from "../../src/communicator/core.ts";
import { nowTs, type AgentEvent } from "../../src/events.ts";
import { TOOL_NAMES } from "../../src/tools/definitions.ts";
import { SchemaOracle } from "../harness/schema_validate.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ev = (partial: Record<string, unknown>): AgentEvent => ({ ts: nowTs(), proc: "exec", ...partial }) as unknown as AgentEvent;
const pricing = { zai: { "glm-5.2": { input_per_1m: 1, cached_per_1m: 0.2, output_per_1m: 3 } }, openai: { "gpt-4.1-mini": { input_per_1m: 0.4, cached_per_1m: 0.1, output_per_1m: 1.6 } } };
const models = { generating: { provider: "zai", modelId: "glm-5.2" }, compacting: { provider: "openai", modelId: "gpt-4.1-mini" }, supervisor: { provider: "openai", modelId: "gpt-4.1-mini" }, memory: { provider: "openai", modelId: "unpriced" }, communicator: { provider: "openai", modelId: "gpt-4.1-mini" } };

function connection(): { conn: AcpConnection; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const conn = new AcpConnection({ write: async (t) => void out.push(t), stderr: (l) => err.push(l) });
  return { conn, out, err };
}

describe("HERAV1ACP-TP01 connection", () => {
  test("HERAV1ACP-IP01-TC-01/02 parse: garbage → -32700 null id; JSON without jsonrpc → -32600; unknown method → -32601; processing continues", async () => {
    const { conn, out } = connection();
    const requests: string[] = [];
    conn.onRequest((r) => {
      requests.push(r.method);
      conn.respond(r.id, { ok: true });
    });
    conn.feed("{this is not json");
    conn.feed('{"id": 7, "method": "x"}');
    conn.feed('{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}\r');
    await conn.writer.flush();
    const lines = out.map((l) => JSON.parse(l) as { id: unknown; error?: { code: number }; result?: unknown });
    expect(lines[0]).toMatchObject({ id: null, error: { code: PARSE_ERROR } });
    expect(lines[1]).toMatchObject({ id: 7, error: { code: INVALID_REQUEST } });
    expect(lines[2]).toMatchObject({ id: 1, result: { ok: true } });
    expect(requests).toEqual(["initialize"]);
    for (const l of out) expect(l.endsWith("\n") && !l.slice(0, -1).includes("\n")).toBe(true);
    expect(parseLine('{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}')).toMatchObject({ kind: "notification", method: "session/cancel" });
    expect(parseLine('{"jsonrpc":"2.0","id":100,"result":{"outcome":{"outcome":"selected"}}}')).toMatchObject({ kind: "response", id: 100 });
    expect(parseLine('{"jsonrpc":"2.0","id":3}')).toMatchObject({ kind: "parse_failure", code: INVALID_REQUEST });
    const { conn: noHandler, out: out2 } = connection();
    noHandler.feed('{"jsonrpc":"2.0","id":9,"method":"nope"}');
    await noHandler.writer.flush();
    expect(JSON.parse(out2[0] as string)).toMatchObject({ error: { code: METHOD_NOT_FOUND } });
    expect(toLine({ id: 1, result: { text: "a\nb" } })).not.toContain("\n");
  });

  test("HERAV1ACP-IP01-TC-03 agent-originated ids are independent of client ids; responses correlate by id; cancelPending rejects", async () => {
    const { conn, out, err } = connection();
    const p1 = conn.request("session/request_permission", { a: 1 });
    const p2 = conn.request("elicitation/create", { b: 2 });
    await conn.writer.flush();
    const sent = out.map((l) => JSON.parse(l) as { id: number; method: string });
    expect(sent.map((s) => s.id)).toEqual([100, 101]);
    // a client request with the same numeric id does not collide
    conn.onRequest((r) => conn.respond(r.id, {}));
    conn.feed('{"jsonrpc":"2.0","id":100,"method":"session/new","params":{}}');
    conn.feed('{"jsonrpc":"2.0","id":100,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}');
    expect(await p1).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    conn.feed('{"jsonrpc":"2.0","id":555,"result":{}}');
    expect(err.some((l) => l.includes("unknown request id 555"))).toBe(true);
    conn.cancelPending("test");
    await expect(p2).rejects.toBeInstanceOf(RoundTripCancelled);
    const p3 = conn.request("elicitation/create", {});
    conn.feed('{"jsonrpc":"2.0","id":102,"error":{"code":-1,"message":"nope"}}');
    await expect(p3).rejects.toBeInstanceOf(ClientErrorResponse);
    expect(conn.pendingCount).toBe(0);
  });

  test("HERAV1ACP-IP01-TC-04 write queue: 12000 droppable notifications against a stalled writer → oldest 2000 dropped, one stderr line, responses and requests retained in order", async () => {
    const written: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const drops: number[] = [];
    const q = new WriteQueue(
      async (t) => {
        if (first) {
          first = false;
          await gate;
        }
        written.push(t);
      },
      (n) => drops.push(n),
    );
    q.enqueue(JSON.stringify({ id: 1, result: {} }), false);
    for (let i = 0; i < 12000; i++) q.enqueue(JSON.stringify({ method: "session/update", i }), true);
    q.enqueue(JSON.stringify({ id: 200, method: "session/request_permission" }), false);
    expect(q.pending).toBe(10000);
    release?.();
    await q.flush();
    const parsed = written.map((w) => JSON.parse(w) as { id?: number; i?: number });
    expect(parsed[0]).toEqual({ id: 1, result: {} });
    const numbered = parsed.filter((p) => p.i !== undefined).map((p) => p.i as number);
    expect(numbered.length).toBe(12000 - 2001);
    for (let k = 1; k < numbered.length; k++) expect((numbered[k] as number) > (numbered[k - 1] as number)).toBe(true);
    expect(parsed.at(-1)).toEqual({ id: 200, method: "session/request_permission" });
    expect(drops).toEqual([2001]);
    expect(q.dropped).toBe(2001);
  });
});

describe("HERAV1ACP-TP01 translator", () => {
  const make = (replaying = false): { t: EventTranslator; err: string[]; ledger: CostLedger } => {
    const err: string[] = [];
    const ledger = new CostLedger(pricing, models);
    return { t: new EventTranslator({ ledger, contextWindow: 200000, replaying, stderr: (l) => err.push(l) }), err, ledger };
  };

  test("HERAV1ACP-IP01-TC-06/08/09/10 every one of the 18 event types maps or is a documented omission; messageId rotates per turn; role filter; blocked → failed; severity prefixes", () => {
    const { t, err, ledger } = make();
    const all: Record<string, AgentEvent> = {
      session_started: ev({ type: "session_started", system_prompt: "s", tool_definitions: [], config_snapshot: {}, definition_hash: "f", hera_version: "2" }),
      user_message: ev({ type: "user_message", content: "hi" }),
      turn_started: ev({ type: "turn_started", role: "generating" }),
      text_delta: ev({ type: "text_delta", text: "t" }),
      thinking_delta: ev({ type: "thinking_delta", text: "th" }),
      tool_call_requested: ev({ type: "tool_call_requested", id: "tc_1", tool: "run_command", args: { CommandLine: "rm -rf build" }, args_json: "{}" }),
      tool_call_finished: ev({ type: "tool_call_finished", id: "tc_1", status: "blocked", result: "blocked by supervisor: denylist", result_chars: 30 }),
      checkpoint_created: ev({ type: "checkpoint_created", text: "cp", truncated_messages: 3, kept_messages: 1 }),
      turn_finished: ev({ type: "turn_finished", role: "generating", uncached_input: 1000, cache_write: 0, cache_read: 0, output: 50, stop_reason: "end" }),
      error: ev({ type: "error", message: "x", severity: "warning" }),
      prompt_step: { ts: nowTs(), proc: "comm", type: "prompt_step", index: 1, total: 2, digest: "abc" },
      supervisor_intervention: { ts: nowTs(), proc: "sup", type: "supervisor_intervention", kind: "guard_block", text: "blocked run_command (denylist): rm", turn_index: 1 },
      memory_injected: ev({ type: "memory_injected", memory_ids: ["m1", "m2"], bytes: 10 }),
      executor_resumed: ev({ type: "executor_resumed", reason: "restart" }),
      halted: ev({ type: "halted", reason: "user", in_flight: [] }),
      run_ended: ev({ type: "run_ended", reason: "complete" }),
      model_called: ev({ type: "model_called", role: "generating", provider: "zai", model: "glm-5.2", request_chars: 100, response_chars: 50, dur_ms: 500 }),
      memory_written: ev({ type: "memory_written", target: "memory_store", memory_id: "mem_001", scope: "workspace" }),
    };
    expect(Object.keys(all)).toHaveLength(18);
    const mapped: Record<string, Update[]> = {};
    for (const [type, e] of Object.entries(all)) {
      if (type === "turn_finished") ledger.onEvent(e);
      mapped[type] = t.translate(e);
    }
    const noOps = new Set(["session_started", "user_message", "turn_started", "checkpoint_created", "prompt_step", "memory_injected", "model_called", "memory_written"]);
    for (const [type, updates] of Object.entries(mapped)) {
      if (noOps.has(type)) expect(updates).toEqual([]);
      else expect(updates.length > 0 && updates.every((u) => typeof u.sessionUpdate === "string")).toBe(true);
    }
    expect(err.some((l) => l.includes("omitted: checkpoint_created"))).toBe(true);
    expect(err.some((l) => l.includes("omitted: prompt_step"))).toBe(true);
    expect(err.some((l) => l.includes("omitted: memory_injected (2 memories)"))).toBe(true);
    expect(mapped["text_delta"]?.[0]).toMatchObject({ sessionUpdate: "agent_message_chunk", messageId: "msg_1" });
    expect(mapped["thinking_delta"]?.[0]).toMatchObject({ sessionUpdate: "agent_thought_chunk", messageId: "msg_1" });
    expect(mapped["tool_call_requested"]?.[0]).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "tc_1", title: "run_command: rm -rf build", kind: "execute", status: "pending" });
    expect(mapped["tool_call_finished"]?.[0]).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed", content: [{ type: "content", content: { type: "text", text: "blocked by supervisor: denylist" } }] });
    expect(mapped["turn_finished"]?.[0]).toEqual({ sessionUpdate: "usage_update", used: 1050, size: 200000, cost: { amount: ledger.totalUsd, currency: "USD" } });
    expect(mapped["supervisor_intervention"]?.[0]).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "SUPERVISOR: blocked run_command (denylist): rm" } });
    expect(mapped["executor_resumed"]?.[0]).toMatchObject({ content: { text: "NOTICE: executor resumed (restart)" } });
    expect(mapped["halted"]?.[0]).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "HALTED: user" } });
    expect(mapped["run_ended"]?.[0]).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "RUN ENDED: complete" } });
    // severity prefixes in error translation
    expect(mapped["error"]?.[0]).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "WARNING: x" } });
    expect(t.translate(ev({ type: "error", message: "info", severity: "notice" }))[0]).toMatchObject({ content: { text: "NOTICE: info" } });
    expect(t.translate(ev({ type: "error", message: "boom", severity: "error" }))[0]).toMatchObject({ content: { text: "boom" } });
    expect(t.translate(ev({ type: "error", message: "legacy WARNING: prefix" }))[0]).toMatchObject({ content: { text: "legacy WARNING: prefix" } });
    // role filter and the other intervention kinds
    expect(t.translate({ ...ev({ type: "turn_finished", role: "supervisor", uncached_input: 1, cache_write: 0, cache_read: 0, output: 1 }), proc: "sup" } as AgentEvent)).toEqual([]);
    expect(t.translate({ ts: nowTs(), proc: "sup", type: "supervisor_intervention", kind: "governance_note", text: "read first", turn_index: 1 })[0]).toMatchObject({ sessionUpdate: "agent_thought_chunk", content: { text: "SUPERVISOR: read first" } });
    for (const kind of ["stall_resume", "restart_request", "cost_alert"] as const) expect(t.translate({ ts: nowTs(), proc: "sup", type: "supervisor_intervention", kind, text: "x", turn_index: 1 })[0]).toMatchObject({ sessionUpdate: "agent_message_chunk" });
    // messageId rotates
    t.translate(ev({ type: "turn_started", role: "generating" }));
    expect(t.translate(ev({ type: "text_delta", text: "n" }))[0]).toMatchObject({ messageId: "msg_2" });
    // unpriced model → size stays the context window; cost partial but numeric
    const { t: t2 } = make();
    expect((t2.translate(ev({ type: "turn_finished", role: "generating", uncached_input: 1, cache_write: 0, cache_read: 0, output: 1 }))[0] as unknown as { size: number }).size).toBe(200000);
  });

  test("HERAV1ACP-IP01-TC-07 TOOL_KINDS covers exactly the 15 tool definitions; search → search; skill and ask_user_question → other", () => {
    const names = [...TOOL_NAMES].sort();
    expect(Object.keys(TOOL_KINDS).sort()).toEqual(names);
    expect(names).toHaveLength(15);
    expect(TOOL_KINDS["search"]).toBe("search");
    expect(TOOL_KINDS["skill"]).toBe("other");
    expect(TOOL_KINDS["ask_user_question"]).toBe("other");
    expect(TOOL_KINDS["todo_list"]).toBe("think");
  });

  test("todo_list result → plan update; replay emits user chunks, tool pairs, final plan", () => {
    const { t } = make();
    t.translate(ev({ type: "tool_call_requested", id: "t1", tool: "todo_list", args: {}, args_json: "{}" }));
    const result = JSON.stringify({ todos: [{ id: "1", content: "First step", status: "in_progress", priority: "high" }] }, null, 2);
    const updates = t.translate(ev({ type: "tool_call_finished", id: "t1", status: "ok", result, result_chars: result.length }));
    expect(updates[1]).toEqual({ sessionUpdate: "plan", entries: [{ content: "First step", priority: "high", status: "in_progress" }] });
    expect(todoPlan("not json")).toBeUndefined();
    const { t: r } = make(true);
    expect(r.translate(ev({ type: "user_message", content: "hi" }))[0]).toEqual({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } });
  });
});

describe("HERAV1ACP-TP01 brokers and shapes", () => {
  const fakeComm = (): { comm: Communicator; answers: unknown[]; continues: boolean[]; resolves: Array<{ id: string; decision: string }> } => {
    const answers: unknown[] = [];
    const continues: boolean[] = [];
    const resolves: Array<{ id: string; decision: string }> = [];
    const comm = { answer: (a: unknown) => void answers.push(a), continueDecision: (p: boolean) => void continues.push(p), resolvePending: (id: string, decision: string) => void resolves.push({ id, decision }) } as unknown as Communicator;
    return { comm, answers, continues, resolves };
  };

  test("HERAV1ACP-IP01-TC-05 capability gate: elicitation {} does not imply form support; form present → yes", () => {
    expect(ElicitationBroker.formSupportedFrom({ elicitation: {} })).toBe(false);
    expect(ElicitationBroker.formSupportedFrom({ elicitation: { form: null } })).toBe(false);
    expect(ElicitationBroker.formSupportedFrom({ elicitation: { form: {} } })).toBe(true);
    expect(ElicitationBroker.formSupportedFrom(undefined)).toBe(false);
  });

  test("continue broker: allow-once → proceed true; reject-once → false; cancelled → false; client error → false", async () => {
    const { conn, out } = connection();
    const { comm, continues } = fakeComm();
    const broker = new ContinueBroker({ connection: conn, comm, sessionId: () => "s1", stderr: () => undefined });
    const p1 = broker.handle({ kind: "continue", request_id: "ask_1", detail: "Tool call limit (40) reached." });
    await conn.writer.flush();
    const req = JSON.parse(out[0] as string) as { id: number; method: string; params: Record<string, unknown> };
    expect(req.method).toBe("session/request_permission");
    expect(req.params).toEqual({ sessionId: "s1", toolCall: { toolCallId: "continue_1" }, options: [{ optionId: "allow-once", name: "Continue", kind: "allow_once" }, { optionId: "reject-once", name: "Stop", kind: "reject_once" }] });
    conn.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } }));
    await p1;
    const p2 = broker.handle({ kind: "continue", request_id: "ask_2" });
    conn.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id + 1, result: { outcome: { outcome: "selected", optionId: "reject-once" } } }));
    await p2;
    const p3 = broker.handle({ kind: "continue", request_id: "ask_3" });
    conn.cancelPending("cancel");
    await p3;
    const p4 = broker.handle({ kind: "continue", request_id: "ask_4" });
    conn.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id + 3, error: { code: -1, message: "no" } }));
    await p4;
    expect(continues).toEqual([true, false, false, false]);
  });

  test("HERAV1ACP-IP01-TC-37 permission broker: request shape matches ACP-08; allow-once → allow; reject-once → deny; cancelled → deny; client error → deny + warning", async () => {
    const { conn, out } = connection();
    const { comm, resolves } = fakeComm();
    const warnChunks: string[] = [];
    const broker = new PermissionBroker({ connection: conn, comm, sessionId: () => "s1", stderr: () => undefined, warn: (t) => void warnChunks.push(t) });
    const p1 = broker.handle({ kind: "pending", request_id: "pending_fx1", effect_id: "fx_1", tool: "run_command", summary: "echo hello", reason: "pending: awaiting user decision" }, "call_1");
    await conn.writer.flush();
    const req = JSON.parse(out[0] as string) as { id: number; method: string; params: Record<string, unknown> };
    expect(req.method).toBe("session/request_permission");
    expect(req.params).toEqual({ sessionId: "s1", toolCall: { toolCallId: "call_1", title: "echo hello" }, options: PERMISSION_OPTIONS.map((o) => ({ ...o })) });
    conn.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } }));
    await p1;
    const p2 = broker.handle({ kind: "pending", request_id: "pending_fx2", effect_id: "fx_2", tool: "run_command", summary: "rm -rf" }, "call_2");
    conn.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id + 1, result: { outcome: { outcome: "selected", optionId: "reject-once" } } }));
    await p2;
    const p3 = broker.handle({ kind: "pending", request_id: "pending_fx3", effect_id: "fx_3", tool: "run_command", summary: "curl" }, "call_3");
    conn.cancelPending("cancel");
    await p3;
    const p4 = broker.handle({ kind: "pending", request_id: "pending_fx4", effect_id: "fx_4", tool: "run_command", summary: "wget" }, "call_4");
    conn.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id + 3, error: { code: -1, message: "no" } }));
    await p4;
    expect(resolves).toEqual([{ id: "fx_1", decision: "allow" }, { id: "fx_2", decision: "deny" }, { id: "fx_3", decision: "deny" }, { id: "fx_4", decision: "deny" }]);
    expect(warnChunks).toEqual(["WARNING: permission request failed - effect denied"]);
  });

  test("elicitation broker: form → enum property, multi-select array, accept → selected labels; decline → fallback; no capability → fallback text without a wire request", async () => {
    const { conn, out } = connection();
    const { comm, answers } = fakeComm();
    const broker = new ElicitationBroker({ connection: conn, comm, sessionId: () => "s1", stderr: () => undefined });
    await broker.handle({ kind: "question", request_id: "ask_1", question: "Pick", options: [{ label: "x", description: "option x" }] });
    expect(answers[0]).toEqual({ request_id: "ask_1", text: NO_ELICITATION_FALLBACK });
    expect(out).toHaveLength(0);
    broker.formSupported = true;
    const p = broker.handle({ kind: "question", request_id: "ask_2", question: "Pick a color", options: [{ label: "red", description: "r" }, { label: "blue", description: "b" }], allow_multiple: false });
    await conn.writer.flush();
    const req = JSON.parse(out[0] as string) as { id: number; method: string; params: Record<string, unknown> };
    expect(req.method).toBe("elicitation/create");
    expect(req.params).toMatchObject({ sessionId: "s1", mode: "form", message: "Pick a color", requestedSchema: { type: "object", properties: { answer: { type: "string", enum: ["red", "blue"] } }, required: ["answer"] } });
    conn.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { action: "accept", content: { answer: "red" } } }));
    await p;
    expect(answers[1]).toEqual({ request_id: "ask_2", selected: ["red"] });
    const multi = ElicitationBroker.params("s1", { kind: "question", request_id: "ask_3", question: "Many", options: [{ label: "a" }, { label: "b" }], allow_multiple: true });
    expect((multi["requestedSchema"] as { properties: { answer: unknown } }).properties.answer).toMatchObject({ type: "array", items: { type: "string", enum: ["a", "b"] } });
    const p2 = broker.handle({ kind: "question", request_id: "ask_4", question: "Q", options: [{ label: "a" }] });
    conn.feed(JSON.stringify({ jsonrpc: "2.0", id: req.id + 1, result: { action: "decline" } }));
    await p2;
    expect(answers[2]).toEqual({ request_id: "ask_4", text: "no answer (user declined)" });
    const p3 = broker.handle({ kind: "question", request_id: "ask_5", question: "Q", options: [{ label: "a" }] });
    conn.cancelPending("session/cancel");
    await p3;
    expect(answers[3]).toEqual({ request_id: "ask_5", text: "no answer (cancelled)" });
  });

  test("HERAV1ACP-IP01-TC-11 schema oracle: every outbound shape validates against schema/schema.json", () => {
    const oracle = new SchemaOracle();
    oracle.assertValid("InitializeResponse", initializeResult());
    const { t, ledger } = make();
    const events: AgentEvent[] = [
      ev({ type: "turn_started", role: "generating" }),
      ev({ type: "text_delta", text: "hello" }),
      ev({ type: "thinking_delta", text: "hmm" }),
      ev({ type: "tool_call_requested", id: "tc_1", tool: "read_file", args: { file_path: "a.md" }, args_json: "{}" }),
      ev({ type: "tool_call_finished", id: "tc_1", status: "ok", result: "content", result_chars: 7 }),
      ev({ type: "tool_call_requested", id: "tc_2", tool: "todo_list", args: {}, args_json: "{}" }),
      ev({ type: "tool_call_finished", id: "tc_2", status: "ok", result: JSON.stringify({ todos: [{ id: "1", content: "a", status: "pending", priority: "low" }] }), result_chars: 10 }),
      ev({ type: "tool_call_finished", id: "tc_3", status: "blocked", result: "blocked by supervisor: denylist", result_chars: 3 }),
      ev({ type: "error", message: "WARNING: slow" }),
      { ts: nowTs(), proc: "sup", type: "supervisor_intervention", kind: "guard_block", text: "blocked", turn_index: 1 },
      { ts: nowTs(), proc: "sup", type: "supervisor_intervention", kind: "governance_note", text: "note", turn_index: 1 },
      ev({ type: "executor_resumed", reason: "frozen" }),
      ev({ type: "turn_finished", role: "generating", uncached_input: 2300, cache_write: 0, cache_read: 0, output: 100, stop_reason: "end" }),
    ];
    let count = 0;
    for (const e of events) {
      ledger.onEvent(e);
      for (const update of t.translate(e)) {
        oracle.assertValid("SessionUpdate", update);
        oracle.assertValid("SessionNotification", { sessionId: "2026-09-06_071000_a1b2", update });
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(12);
    oracle.assertValid("SessionNotification", { sessionId: "s", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "prime", description: "Prime" }] } });
    oracle.assertValid("SessionNotification", { sessionId: "s", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } } });
    oracle.assertValid("PromptResponse", { stopReason: "end_turn" });
    oracle.assertValid("PromptResponse", { stopReason: "cancelled" });
    oracle.assertValid("RequestPermissionRequest", ContinueBroker.params("s", 3));
    oracle.assertValid("RequestPermissionRequest", PermissionBroker.params("s", "call_1", "echo hello"));
    oracle.assertValid("CreateElicitationRequest", ElicitationBroker.params("s", { kind: "question", request_id: "a", question: "Pick", options: [{ label: "red", description: "r" }], allow_multiple: false }));
    oracle.assertValid("CreateElicitationRequest", ElicitationBroker.params("s", { kind: "question", request_id: "a", question: "Pick", options: [{ label: "red" }, { label: "blue" }], allow_multiple: true }));
    oracle.assertValid("NewSessionResponse", { sessionId: "2026-09-06_071000_a1b2" });
    // negative control: the oracle rejects a wrong shape
    expect(oracle.validate("PromptResponse", { stopReason: "nope" }).length).toBeGreaterThan(0);
    expect(oracle.validate("SessionUpdate", { sessionUpdate: "usage_update", used: -1, size: 0 }).length).toBeGreaterThan(0);
  });

  test("prompt assembly: text verbatim, resource_link flattened, image → -32602 naming the type, empty → -32602", () => {
    expect(assemblePromptText({ prompt: [{ type: "text", text: "Analyze this file" }, { type: "resource_link", uri: "file:///proj/main.py", name: "main.py" }] })).toBe("Analyze this file\n[resource: main.py](file:///proj/main.py)");
    expect(() => assemblePromptText({ prompt: [{ type: "image", data: "...", mimeType: "image/png" }] })).toThrow(/'image'/);
    expect(() => assemblePromptText({ prompt: [] })).toThrow(/no content blocks/);
    expect(() => assemblePromptText({ prompt: [{ type: "text", text: "  " }] })).toThrow(/no text content/);
  });
});

const make = (replaying = false): { t: EventTranslator; err: string[]; ledger: CostLedger } => {
  const err: string[] = [];
  const ledger = new CostLedger(pricing, models);
  return { t: new EventTranslator({ ledger, contextWindow: 200000, replaying, stderr: (l) => err.push(l) }), err, ledger };
};

describe("HERAV1ACP-TP01 static guardrails", () => {
  test("HERAV1ACP-IP01-VC-09 / TC-36: no request handler awaits IPC (server.ts has no await); no console.log or process.stdout in src/acp", () => {
    const dir = join(import.meta.dir, "..", "..", "src", "acp");
    const server = readFileSync(join(dir, "server.ts"), "utf8");
    expect(/\bawait\b/.test(server.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))).toBe(false);
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8").replace(/\/\/.*$/gm, "");
      expect(text.includes("console.log")).toBe(false);
      if (file !== "main.ts") expect(text.includes("process.stdout")).toBe(false);
    }
  });
});
