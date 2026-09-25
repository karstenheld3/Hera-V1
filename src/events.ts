// AgentEvent union (20 types) and JSONL serialization (HERAV1AGNT-SP01 section 3, HERAV1AGNT-IP01 IS-05).
// This file is the wire contract for the session JSONL AND the `event` IPC payload (HERAV1PROC-SP01 DD-02).
// Wire field names stay V1 snake_case so V1 session files remain readable.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { ERROR_CATEGORIES, EventParseError } from "./errors.ts";
import { PROC_IDS, PROVIDER_IDS, ROLE_NAMES, STOP_REASONS, TOOL_CALL_FINISHED_STATUSES } from "./models.ts";

export const EVENT_TYPES = [
  "session_started",
  "user_message",
  "turn_started",
  "text_delta",
  "thinking_delta",
  "tool_call_requested",
  "tool_call_finished",
  "checkpoint_created",
  "turn_finished",
  "error",
  "prompt_step",
  "supervisor_intervention",
  "memory_injected",
  "executor_resumed",
  "halted",
  "run_ended",
  "model_called",
  "memory_written",
  "effect_pending",
  "effect_resolved",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const INTERVENTION_KINDS = ["guard_block", "governance_note", "stall_resume", "restart_request", "cost_alert"] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

export const RESUME_REASONS = ["frozen", "tool_hang", "restart"] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];

const base = {
  ts: z.string().min(1),
  proc: z.enum(PROC_IDS),
  run_ctx: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  prompt_id: z.string().optional(),
  legacy: z.literal(true).optional(),
};

const UsageWire = z.object({
  uncached_input: z.number().int().nonnegative().default(0),
  cache_write: z.number().int().nonnegative().default(0),
  cache_read: z.number().int().nonnegative().default(0),
  output: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nullable().optional(),
});
export type UsageWire = z.infer<typeof UsageWire>;

const ThinkingPayload = z.object({ provider: z.enum(PROVIDER_IDS), payload: z.unknown() });

export const SessionStarted = z.object({
  ...base,
  type: z.literal("session_started"),
  system_prompt: z.string(),
  tool_definitions: z.array(z.record(z.string(), z.unknown())).default([]),
  config_snapshot: z.record(z.string(), z.unknown()).default({}),
  definition_hash: z.string().default(""),
  profile: z.string().optional(),
});

export const UserMessage = z.object({
  ...base,
  type: z.literal("user_message"),
  content: z.string(),
  expanded_workflow: z.string().optional(),
});

export const TurnStarted = z.object({ ...base, type: z.literal("turn_started"), role: z.enum(ROLE_NAMES).default("generating") });
export const TextDelta = z.object({ ...base, type: z.literal("text_delta"), text: z.string() });
export const ThinkingDelta = z.object({ ...base, type: z.literal("thinking_delta"), text: z.string() });

export const ToolCallRequested = z.object({
  ...base,
  type: z.literal("tool_call_requested"),
  id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  args_json: z.string().optional(),
});

export const ToolCallFinished = z.object({
  ...base,
  type: z.literal("tool_call_finished"),
  id: z.string().min(1),
  status: z.enum(TOOL_CALL_FINISHED_STATUSES),
  result: z.string().default(""),
  result_chars: z.number().int().nonnegative().default(0),
  injected_note: z.string().optional(),
});

export const CheckpointCreated = z.object({
  ...base,
  type: z.literal("checkpoint_created"),
  text: z.string(),
  truncated_messages: z.number().int().nonnegative().default(0),
  kept_messages: z.number().int().nonnegative().default(0),
  usage: UsageWire.optional(),
});

export const TurnFinished = z.object({
  ...base,
  type: z.literal("turn_finished"),
  role: z.enum(ROLE_NAMES).default("generating"),
  uncached_input: z.number().int().nonnegative().default(0),
  cache_write: z.number().int().nonnegative().default(0),
  cache_read: z.number().int().nonnegative().default(0),
  output: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nullable().optional(),
  stop_reason: z.enum(STOP_REASONS).optional(),
  thinking_payloads: z.array(ThinkingPayload).optional(),
  request: z.string().optional(),
  text: z.string().optional(),
});

export const ERROR_SEVERITIES = ["error", "warning", "notice"] as const;
export type ErrorSeverity = (typeof ERROR_SEVERITIES)[number];

export const ErrorEvent = z.object({
  ...base,
  type: z.literal("error"),
  message: z.string(),
  severity: z.enum(ERROR_SEVERITIES).optional(),
  category: z.enum(ERROR_CATEGORIES).optional(),
});

export const PromptStep = z.object({
  ...base,
  type: z.literal("prompt_step"),
  index: z.number().int().positive(),
  total: z.number().int().positive(),
  digest: z.string().default(""),
});

export const SupervisorIntervention = z.object({
  ...base,
  type: z.literal("supervisor_intervention"),
  kind: z.enum(INTERVENTION_KINDS),
  tool_call_id: z.string().optional(),
  rule: z.string().optional(),
  text: z.string(),
  turn_index: z.number().int().nonnegative(),
});

export const MemoryInjected = z.object({
  ...base,
  type: z.literal("memory_injected"),
  memory_ids: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
});

export const ExecutorResumed = z.object({ ...base, type: z.literal("executor_resumed"), reason: z.enum(RESUME_REASONS) });

export const Halted = z.object({
  ...base,
  type: z.literal("halted"),
  reason: z.string().optional(),
  in_flight: z.array(z.object({
    effect_id: z.string(),
    kind: z.string(),
    target: z.string(),
    status: z.string(),
  })).default([]),
});

export const RunEnded = z.object({
  ...base,
  type: z.literal("run_ended"),
  reason: z.string().optional(),
});

export const ModelCalled = z.object({
  ...base,
  type: z.literal("model_called"),
  model_ref: z.string(),
  prompt_hash: z.string(),
});

export const MemoryWritten = z.object({
  ...base,
  type: z.literal("memory_written"),
  target: z.string(),
  memory_id: z.string().optional(),
  scope: z.string().optional(),
});

export const EffectPending = z.object({
  ...base,
  type: z.literal("effect_pending"),
  effect_id: z.string().min(1),
  tool: z.string().min(1),
  reason: z.string(),
});

export const EffectResolved = z.object({
  ...base,
  type: z.literal("effect_resolved"),
  effect_id: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  SessionStarted,
  UserMessage,
  TurnStarted,
  TextDelta,
  ThinkingDelta,
  ToolCallRequested,
  ToolCallFinished,
  CheckpointCreated,
  TurnFinished,
  ErrorEvent,
  PromptStep,
  SupervisorIntervention,
  MemoryInjected,
  ExecutorResumed,
  Halted,
  RunEnded,
  ModelCalled,
  MemoryWritten,
  EffectPending,
  EffectResolved,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type EventOf<T extends EventType> = Extract<AgentEvent, { type: T }>;

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function nowTs(date: Date = new Date()): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} ${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

/** Compact one-line JSON; `undefined` fields are dropped by JSON.stringify, `legacy` is in-memory only (EC-03). */
export function toJsonl(event: AgentEvent): string {
  if (event.legacy === true) {
    const { legacy: _legacy, ...rest } = event;
    return JSON.stringify(rest);
  }
  return JSON.stringify(event);
}

/** Legacy V1 line normalization (EC-03, EC-05): missing `proc` → exec + legacy flag; role "generator" → "generating";
 *  V1 usage fields (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) → four-category fields. */
function normalizeLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  const needsProc = raw["proc"] === undefined;
  const needsRole = raw["role"] === "generator" || raw["role"] === "summarizer";
  const hasV1Usage = raw["input_tokens"] !== undefined && raw["uncached_input"] === undefined;
  const hasV1CheckpointUsage = raw["usage"] !== undefined && typeof raw["usage"] === "object" && raw["usage"] !== null && (raw["usage"] as Record<string, unknown>)["input_tokens"] !== undefined && (raw["usage"] as Record<string, unknown>)["uncached_input"] === undefined;
  const hasLegacyPromptHash = raw["prompt_system_fingerprint"] !== undefined && raw["definition_hash"] === undefined;
  if (!needsProc && !needsRole && !hasV1Usage && !hasV1CheckpointUsage && !hasLegacyPromptHash) return raw;
  const out: Record<string, unknown> = { ...raw };
  if (needsProc) {
    out["proc"] = "exec";
    out["legacy"] = true;
  }
  if (out["role"] === "generator") out["role"] = "generating";
  if (out["role"] === "summarizer") out["role"] = "compacting";
  if (hasLegacyPromptHash) {
    const lh = out["prompt_system_fingerprint"] as Record<string, unknown> | undefined;
    out["definition_hash"] = typeof lh?.["hash"] === "string" ? lh["hash"] : "";
    delete out["prompt_system_fingerprint"];
  }
  if (hasV1Usage) {
    const input = (out["input_tokens"] as number) ?? 0;
    const cacheRead = (out["cache_read_tokens"] as number) ?? 0;
    const cacheWrite = (out["cache_write_tokens"] as number) ?? 0;
    out["uncached_input"] = Math.max(0, input - cacheRead - cacheWrite);
    out["cache_write"] = cacheWrite;
    out["cache_read"] = cacheRead;
    out["output"] = (out["output_tokens"] as number) ?? 0;
    delete out["input_tokens"];
    delete out["output_tokens"];
    delete out["cache_read_tokens"];
    delete out["cache_write_tokens"];
  }
  if (hasV1CheckpointUsage) {
    const u = out["usage"] as Record<string, unknown>;
    const input = (u["input_tokens"] as number) ?? 0;
    const cacheRead = (u["cache_read_tokens"] as number) ?? 0;
    const cacheWrite = (u["cache_write_tokens"] as number) ?? 0;
    u["uncached_input"] = Math.max(0, input - cacheRead - cacheWrite);
    u["cache_write"] = cacheWrite;
    u["cache_read"] = cacheRead;
    u["output"] = (u["output_tokens"] as number) ?? 0;
    delete u["input_tokens"];
    delete u["output_tokens"];
    delete u["cache_read_tokens"];
    delete u["cache_write_tokens"];
  }
  return out;
}

export function fromJsonl(line: string, lineNo?: number): AgentEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new EventParseError(`invalid JSON in session line: ${error instanceof Error ? error.message : String(error)}`, lineNo);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EventParseError("session line is not a JSON object", lineNo);
  }
  const record = raw as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string" || !EVENT_TYPE_SET.has(type)) {
    throw new EventParseError(`unknown event type '${String(type)}'`, lineNo);
  }
  const result = AgentEventSchema.safeParse(normalizeLegacy(record));
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    throw new EventParseError(`event '${type}' field ${path}: ${issue?.message ?? "invalid"}`, lineNo);
  }
  return result.data;
}

export interface JsonlReadResult {
  events: AgentEvent[];
  warnings: string[];
  /** true when only the last non-empty line failed to parse (crash tail, EC-02) */
  truncatedTail: boolean;
}

/** Tolerant reader for projections: invalid lines are skipped with one WARNING each, never a crash (EC-01, EC-02). */
export function readJsonlText(text: string, source = "session"): JsonlReadResult {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const events: AgentEvent[] = [];
  const warnings: string[] = [];
  let lastFailed = false;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      events.push(fromJsonl(line, index + 1));
      lastFailed = false;
    } catch (error) {
      warnings.push(`WARNING: ${source} line ${index + 1} skipped: ${error instanceof Error ? error.message : String(error)}`);
      lastFailed = index === lines.length - 1;
    }
  }
  return { events, warnings, truncatedTail: lastFailed && warnings.length === 1 };
}

export function readJsonlFile(path: string): JsonlReadResult {
  return readJsonlText(readFileSync(path, "utf8"), path);
}

export function isEventType<T extends EventType>(event: AgentEvent, type: T): event is EventOf<T> {
  return event.type === type;
}
