import { describe, expect, test } from "bun:test";
import { nowTs } from "../../src/events.ts";
import { MESSAGE_TYPES, validate, type IpcMessage, type MessageType, type PayloadOf } from "../../src/process/envelope.ts";

const ts = "2026-01-15 10:00:00.000";
const env = <T extends MessageType>(type: T, payload: PayloadOf<T>, extra: Partial<IpcMessage> = {}): unknown => ({ v: 1, id: 1, from: "exec", to: "comm", type, ts, payload, ...extra });

const VALID: { [K in MessageType]: PayloadOf<K> } = {
  hello: { role: "executor", pid: 1234, version: "2.0.0", standalone: false, epoch: 1 },
  ack: { ref: 42 },
  heartbeat: { turn_active: true, last_event_id: 42, pid: 1234, phase: "tool_call", phase_since: ts, turn_usage: { uncached_input: 1, cache_write: 0, cache_read: 0, output: 2, cost_usd: 0.001 }, children: [8812] },
  session_open: { session_id: "s1", jsonl_path: "C:/data/sessions/s1.jsonl", mode: "new", workspace: "C:/work", app_dir: "C:/app", config_path: "C:/app/config/agent-config.json" },
  prompt: { text: "hello", note: undefined },
  cancel: {},
  continue: { proceed: true },
  ask_user: { kind: "question", request_id: "q1", question: "Which?", options: [{ label: "A" }], allow_multiple: false },
  answer: { request_id: "q1", text: "A" },
  event: { ts, proc: "exec", type: "text_delta", text: "hi" },
  inject: { kind: "memory", text: "<memory_system>...</memory_system>", memory_ids: ["m1"] },
  resolve: { effect_id: "fx_1" },
  resume: { reason: "frozen", phase: "model_call" },
  restart_request: { reason: "stall escalation" },
  debug_line: { ts, proc: "exec", dom: "ipc", op: "ack" },
  shutdown: {},
  halt: { reason: "halted by user" },
  halted: { reason: "halted by user", in_flight: [] },
  admit_result: { status: "admitted", run_ctx: "AAAAAAAAAAAAQQ==", exposure: undefined },
};

describe("HERAV1PROC-TP01 envelope", () => {
  test("HERAV1PROC-IP01-TC-01 validate accepts all 19 types and rejects unknown type, missing ts, v 2", () => {
    expect(MESSAGE_TYPES).toHaveLength(19);
    for (const type of MESSAGE_TYPES) {
      const result = validate(env(type, VALID[type]));
      expect(result.ok, `type ${type}: ${result.ok ? "" : result.reason}`).toBe(true);
      if (result.ok) expect(result.msg.type).toBe(type);
    }
    const unknown = validate({ v: 1, id: 1, from: "exec", to: "comm", type: "gossip", ts, payload: {} });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toContain("gossip");
    const noTs = validate({ v: 1, id: 1, from: "exec", to: "comm", type: "shutdown", payload: {} });
    expect(noTs.ok).toBe(false);
    if (!noTs.ok) expect(noTs.reason).toContain("ts");
    const v2 = validate({ ...(env("shutdown", {}) as object), v: 2 });
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.reason).toContain("version");
    expect(validate(null).ok).toBe(false);
    expect(validate("string").ok).toBe(false);
  });

  test("HERAV1PROC-TP01-TC-06 payload validation names the field", () => {
    const badHello = validate(env("hello", { role: "auditor", pid: 1, version: "x", standalone: false, epoch: 1 } as unknown as PayloadOf<"hello">));
    expect(badHello.ok).toBe(false);
    if (!badHello.ok) expect(badHello.reason).toContain("role");
    const badEvent = validate(env("event", { ts, proc: "exec", type: "approval_required" } as unknown as PayloadOf<"event">));
    expect(badEvent.ok).toBe(false);
    const badId = validate(env("ack", { ref: 1 }, { id: 0 }));
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.reason).toContain("id");
  });

  test("event payload is the JSONL object incl. ts and proc", () => {
    const result = validate(env("event", { ts: nowTs(), proc: "exec", type: "tool_call_requested", id: "tc_0007", tool: "read_file", args: { file_path: "README.md" } }));
    expect(result.ok).toBe(true);
    if (result.ok && result.msg.type === "event") {
      expect(result.msg.payload.proc).toBe("exec");
      expect(result.msg.payload.type).toBe("tool_call_requested");
    }
  });

  test("U07: resolve payload accepts optional decision field", () => {
    const withoutDecision = validate(env("resolve", { effect_id: "fx_1" }));
    expect(withoutDecision.ok).toBe(true);
    const withAllow = validate(env("resolve", { effect_id: "fx_1", decision: "allow" }));
    expect(withAllow.ok).toBe(true);
    if (withAllow.ok && withAllow.msg.type === "resolve") {
      expect(withAllow.msg.payload.decision).toBe("allow");
    }
    const withDeny = validate(env("resolve", { effect_id: "fx_1", decision: "deny" }));
    expect(withDeny.ok).toBe(true);
    const badDecision = validate(env("resolve", { effect_id: "fx_1", decision: "maybe" as unknown as "allow" }));
    expect(badDecision.ok).toBe(false);
  });

  test("U07: ask_user pending payload accepts tool, summary, reason", () => {
    const pendingPayload: PayloadOf<"ask_user"> = { kind: "pending", request_id: "pending_fx_1", effect_id: "fx_1", tool: "run_command", summary: "curl example.com", reason: "pending: awaiting user decision" };
    const result = validate(env("ask_user", pendingPayload));
    expect(result.ok).toBe(true);
    if (result.ok && result.msg.type === "ask_user") {
      expect(result.msg.payload.tool).toBe("run_command");
      expect(result.msg.payload.summary).toBe("curl example.com");
      expect(result.msg.payload.reason).toBe("pending: awaiting user decision");
    }
  });
});
