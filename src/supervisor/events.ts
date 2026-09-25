// Supervisor-owned events (HERAV1SUPV-SP01 FR-06; HERAV1SUPV-IP01 IS-02): supervisor_intervention records and the
// turn_finished lines of the supervisor and memory roles. Everything the Supervisor does is visible in the session log.

import { nowTs, type AgentEvent } from "../events.ts";
import type { Usage } from "../models.ts";

export type InterventionKind = "guard_block" | "governance_note" | "stall_resume" | "restart_request" | "cost_alert";

export interface InterventionCounters {
  guard_block: number;
  governance_note: number;
  stall_resume: number;
  restart_request: number;
  cost_alert: number;
}

export function zeroCounters(): InterventionCounters {
  return { guard_block: 0, governance_note: 0, stall_resume: 0, restart_request: 0, cost_alert: 0 };
}

export function interventionEvent(kind: InterventionKind, text: string, turnIndex: number, extra: { toolCallId?: string; rule?: string } = {}): AgentEvent {
  return {
    ts: nowTs(),
    proc: "sup",
    type: "supervisor_intervention",
    kind,
    text,
    turn_index: turnIndex,
    ...(extra.toolCallId !== undefined ? { tool_call_id: extra.toolCallId } : {}),
    ...(extra.rule !== undefined ? { rule: extra.rule } : {}),
  };
}

export function roleUsageEvent(role: "supervisor" | "memory", usage: Usage, costUsd: number | undefined, request: string, text: string): AgentEvent {
  return {
    ts: nowTs(),
    proc: "sup",
    type: "turn_finished",
    role,
    uncached_input: usage.uncachedInput,
    cache_write: usage.cacheWrite,
    cache_read: usage.cacheRead,
    output: usage.output,
    cost_usd: costUsd ?? null,
    stop_reason: "end",
    request: request.slice(0, 2000),
    text: text.slice(0, 2000),
  };
}
