// Stub Executor / Supervisor (HERAV1PROC-TP01 section 3): a test double that speaks the real envelope through
// ChildRuntime. Selected by HERA_STUB_ROLE_MODULE (this file) + HERA_STUB_ROLE_BEHAVIOR (behavior name).
// Facts are reported to the parent as debug_line messages with dom "stub" so recorders can assert them.

import { openSync, closeSync, readFileSync } from "node:fs";
import { nowTs, type AgentEvent } from "../../../src/events.ts";
import type { ChildRole } from "../../../src/models.ts";
import { ChildRuntime, type RoleHandlers } from "../../../src/process/child.ts";
import type { IpcMessage, PayloadOf } from "../../../src/process/envelope.ts";

export type StubBehavior =
  | "normal"
  | "no_hello"
  | "exit_on_spawn"
  | "exit_mid_turn"
  | "ignore_shutdown"
  | "flood"
  | "silent_heartbeat"
  | "stdout_noise"
  | "reject_probe"
  | "no_ack_session"
  | "guard_probe"
  | "fire_and_forget_then_die"
  | "epoch_zero";

function readIpcConfig(configPath: string): { heartbeatMs: number; ackTimeoutMs: number } {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { ipc?: { heartbeat_s?: number; ack_timeout_ms?: number } };
    return { heartbeatMs: (raw.ipc?.heartbeat_s ?? 5) * 1000, ackTimeoutMs: raw.ipc?.ack_timeout_ms ?? 5000 };
  } catch {
    return { heartbeatMs: 5000, ackTimeoutMs: 5000 };
  }
}

function spawnFakeToolChild(): BunSubprocess {
  return Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

/** `normal` applies to both roles; `exec:exit_mid_turn,sup:normal` selects per role (unnamed roles default to normal). */
export function pickBehavior(role: ChildRole, spec: string): StubBehavior {
  if (!spec.includes(":")) return spec as StubBehavior;
  const map = new Map(spec.split(",").map((part) => part.split(":") as [string, string]));
  return (map.get(role) ?? map.get(role === "executor" ? "exec" : "sup") ?? "normal") as StubBehavior;
}

export async function stubMain(roleName: string, behaviorName: string, epoch: number | undefined): Promise<number> {
  const role = roleName as ChildRole;
  const behavior = pickBehavior(role, behaviorName);
  const proc = role === "executor" ? "exec" : "sup";
  if (behavior === "exit_on_spawn") process.exit(1);
  if (behavior === "no_hello") {
    setInterval(() => {}, 60000); // keep the event loop alive without ever saying hello
    await new Promise<never>(() => {});
  }

  let turnActive = false;
  let phase: PayloadOf<"heartbeat">["phase"] = "idle";
  const children: BunSubprocess[] = [];
  let eventCounter = 0;
  const guardOrder: Array<{ kind: "event_copy"; id: number; toolCallId: string }> = [];
  let runtimeRef: ChildRuntime | undefined;

  const fact = (op: string, fields: Record<string, unknown> = {}): void => {
    runtimeRef?.send("debug_line", { ts: nowTs(), proc, dom: "stub", op, ...fields });
  };
  type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
  const ev = (partial: DistributiveOmit<AgentEvent, "ts" | "proc">): AgentEvent => ({ ts: nowTs(), proc, ...partial }) as AgentEvent;

  const handlers: RoleHandlers = {
    heartbeat: () => ({ turn_active: turnActive, phase, phase_since: nowTs(), children: children.filter((c) => c.exitCode === null).map((c) => c.pid) }),
    async onSessionOpen(payload, rt) {
      const cfg = readIpcConfig(payload.config_path);
      rt.heartbeat.setInterval(cfg.heartbeatMs);
      rt.ackTimeoutMs = cfg.ackTimeoutMs;
      if (behavior === "silent_heartbeat") rt.heartbeat.stop();
      if (behavior === "no_ack_session") await new Promise<never>(() => {});
      if (behavior === "stdout_noise") {
        for (let i = 0; i < 1000; i++) process.stdout.write(`stub stdout noise line ${i}\n`);
      }
      if (behavior === "ignore_shutdown") children.push(spawnFakeToolChild());
      // exclusive-open probe (TC-16): a child must not hold a write handle; report whether an exclusive open succeeds
      let canOpenExclusive = false;
      try {
        const fd = openSync(payload.jsonl_path, "r");
        closeSync(fd);
        canOpenExclusive = true;
      } catch {
        canOpenExclusive = false;
      }
      fact("session_open", {
        mode: payload.mode,
        orphans: payload.orphans ?? [],
        session_id: payload.session_id,
        keys_visible: Object.keys(payload).sort(),
        env: { scripted: process.env["HERA_SCRIPTED_ADAPTER"] ?? null, app_dir: process.env["AGENT_APP_DIR"] ?? null, config: process.env["AGENT_CONFIG"] ?? null },
        can_read_jsonl: canOpenExclusive,
        epoch: rt.epoch,
      });
      if (behavior === "reject_probe") {
        const raw = (m: unknown) => process.send?.(m);
        raw({ v: 2, id: 900, from: proc, to: "comm", type: "shutdown", ts: nowTs(), payload: {} });
        raw({ v: 1, id: 901, from: proc, to: "comm", type: "gossip", ts: nowTs(), payload: {} });
        raw({ v: 1, id: 902, from: proc, to: "comm", type: "shutdown", payload: {} });
      }
    },
    async onMessage(msg, rt) {
      if (role === "supervisor") {
        if (msg.type === "event") {
          const p = msg.payload;
          if (p.type === "tool_call_requested") guardOrder.push({ kind: "event_copy", id: msg.id, toolCallId: p.id });
          if (p.type === "turn_finished") fact("guard_order", { order: guardOrder });
        } else if (msg.type === "heartbeat") {
          fact("relayed_heartbeat", { from: msg.from, children: msg.payload.children ?? [] });
        } else if (msg.type === "prompt") {
          fact("prompt_copy", { text: msg.payload.text });
        }
        return;
      }
      // executor stub
      if (msg.type === "prompt") {
        turnActive = true;
        phase = "model_call";
        fact("prompt", { text: msg.payload.text, note: msg.payload.note ?? null });
        await rt.sendEvent(ev({ type: "turn_started", role: "generating" }), false);
        if (behavior === "exit_mid_turn") {
          children.push(spawnFakeToolChild());
          rt.heartbeat.beatNow();
          await Bun.sleep(50);
          if (msg.payload.note === undefined) process.exit(1);
        }
        if (behavior === "flood") {
          const until = performance.now() + 5000;
          let n = 0;
          while (performance.now() < until) {
            for (let i = 0; i < 50; i++) {
              n++;
              await rt.sendEvent(ev({ type: "text_delta", text: `flood ${n}` }), false);
            }
            await Bun.sleep(100);
          }
          fact("flood_done", { sent: n });
        } else if (behavior === "guard_probe") {
          let failOpen = 0;
          for (let i = 0; i < 100; i++) {
            const toolCallId = `tc_${String(i).padStart(4, "0")}`;
            await rt.sendEvent(ev({ type: "tool_call_requested", id: toolCallId, tool: "read_file", args: { file_path: "README.md" } }), true);
            await rt.sendEvent(ev({ type: "tool_call_finished", id: toolCallId, status: "ok", result: "ok", result_chars: 2 }), false);
          }
          fact("guard_probe_done", { fail_open: failOpen });
        } else if (behavior === "fire_and_forget_then_die") {
          for (let i = 0; i < 50; i++) rt.send("event", ev({ type: "text_delta", text: `ff ${i}` }));
          process.exit(1);
        } else {
          const startedAt = performance.now();
          await rt.sendEvent(ev({ type: "tool_call_requested", id: `tc_${++eventCounter}`, tool: "read_file", args: { file_path: "README.md" } }), true);
          fact("ack_observed", { at_ms: performance.now() - startedAt, tool_call_id: `tc_${eventCounter}` });
          await rt.sendEvent(ev({ type: "text_delta", text: msg.payload.text }), false);
        }
        phase = "idle";
        turnActive = false;
        await rt.sendEvent(ev({ type: "turn_finished", role: "generating", uncached_input: 10, cache_write: 0, cache_read: 0, output: 5, cost_usd: 0.0001, stop_reason: "end" }), true);
        rt.heartbeat.beatNow();
      } else if (msg.type === "cancel") {
        fact("cancel", {});
      }
    },
    async onShutdown(reason) {
      fact("shutdown", { reason });
      if (behavior === "ignore_shutdown" && reason === "shutdown") await new Promise<never>(() => {});
      for (const c of children) c.kill();
      await Bun.sleep(10);
    },
  };
  const runtime = new ChildRuntime(role, behavior === "epoch_zero" ? undefined : epoch, handlers, { heartbeatMs: 1000 });
  runtimeRef = runtime;
  runtime.start();
  await new Promise<never>(() => {});
  return 0;
}

// Direct execution guard (never true under the product entrypoint; kept for manual debugging)
if (import.meta.main) {
  void stubMain(process.argv[2] ?? "executor", process.argv[3] ?? "normal", 1);
}

export type { IpcMessage };
