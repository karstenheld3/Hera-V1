// Built-in commands (HERAV1CLI-SP01 FR-06; HERAV1CLI-IP01 IS-04): answered from Communicator-local state within one
// event-loop tick; no built-in calls a model.

import type { Communicator } from "../communicator/core.ts";
import type { StatusSnapshot } from "../communicator/state.ts";
import type { ResolvedConfig } from "../config/load.ts";
import { digest } from "./prompt_queue.ts";
import type { CostLedger } from "./cost.ts";

export const BUILTINS = ["/help", "/cost", "/status", "/halt", "/exit"] as const;

export interface BuiltinContext {
  comm: Communicator | undefined;
  config: ResolvedConfig;
  ledger: CostLedger;
  workflows: Array<{ name: string; description: string }>;
  recentLines: () => string[];
  queuedPrompt: () => string | undefined;
  env?: Record<string, string | undefined>;
}

export type BuiltinResult = { kind: "lines"; lines: string[] } | { kind: "shutdown" } | { kind: "async"; done: Promise<string[]> } | { kind: "not_builtin" };

export function formatStatus(s: StatusSnapshot, extra: { queuedPrompt: string | undefined; restartBudgetLeft: number }): string[] {
  const lines = [`Session: '${s.sessionId}' (${s.jsonlPath})`];
  for (const c of s.children) {
    const age = c.heartbeatAgeMs === undefined ? "no heartbeat yet" : `heartbeat ${Math.round(c.heartbeatAgeMs / 1000)} s ago`;
    lines.push(`  ${c.role.padEnd(10)} pid='${c.pid ?? "[UNKNOWN]"}' ${c.state}${c.phase !== undefined ? ` (${c.phase})` : ""} - ${age}${c.state === "exited" ? ` (exit='${c.signal ?? c.exitCode ?? "[UNKNOWN]"}')` : ""}`);
  }
  lines.push(`Restarts this session: ${s.restartsThisSession} (budget left this turn: ${extra.restartBudgetLeft})`);
  const kinds = ["guard_block", "governance_note", "stall_resume", "restart_request", "cost_alert"];
  lines.push(`Interventions: ${kinds.map((k) => `${k}=${s.interventions[k] ?? 0}`).join(" ")}`);
  const turn = s.turn === "idle" ? "idle" : s.turn === "running" ? `running since ${Math.round((s.turnSinceMs ?? 0) / 1000)} s (${s.turnToolCalls} tool calls so far)` : "waiting for answer";
  lines.push(`Turn: ${turn}`);
  lines.push(`Queued prompt: ${extra.queuedPrompt === undefined ? "no" : `yes (${digest(extra.queuedPrompt)})`}`);
  lines.push(`Events appended: ${s.eventsAppended}`);
  return lines;
}

export function helpLines(workflows: Array<{ name: string; description: string }>): string[] {
  const lines = ["Built-ins: /help, /cost, /status, /halt, /exit", `Workflows (${workflows.length}):`];
  for (const w of workflows) lines.push(`  /${w.name}: ${w.description}`);
  return lines;
}

export function dispatchBuiltin(line: string, ctx: BuiltinContext): BuiltinResult {
  const trimmed = line.trim();
  if (trimmed === "/help") return { kind: "lines", lines: helpLines(ctx.workflows) };
  if (trimmed === "/cost") return { kind: "lines", lines: ctx.ledger.costTable() };
  if (trimmed === "/status") {
    if (ctx.comm === undefined) return { kind: "lines", lines: ["Status: processes not started."] };
    const status = ctx.comm.status();
    return { kind: "lines", lines: formatStatus(status, { queuedPrompt: ctx.queuedPrompt(), restartBudgetLeft: Math.max(0, ctx.comm.state.budget.perTurnMax - ctx.comm.state.budget.turnRestartsUsed) }) };
  }
  if (trimmed === "/exit") return { kind: "shutdown" };
  if (trimmed === "/halt") {
    ctx.comm?.halt("halted by user");
    return { kind: "lines", lines: ["Halt sent to all processes."] };
  }
  return { kind: "not_builtin" };
}
