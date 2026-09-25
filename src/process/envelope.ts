// IPC envelope and the closed set of 19 message types (HERAV1PROC-SP01 section 3, FR-02; HERAV1PROC-IP01 IS-01).
// The `event` payload IS the JSONL object (DD-02), validated with AgentEventSchema.
// run_ctx is opaque bytes from admit() - Hera never interprets them (FR-06).

import { z } from "zod";
import { AgentEventSchema, RESUME_REASONS } from "../events.ts";
import { CHILD_ROLES, PROC_IDS, type ProcId } from "../models.ts";
import { PROTOCOL_VERSION } from "../version.ts";

export const MESSAGE_TYPES = [
  "hello",
  "ack",
  "heartbeat",
  "session_open",
  "prompt",
  "cancel",
  "continue",
  "ask_user",
  "answer",
  "event",
  "inject",
  "resolve",
  "resume",
  "restart_request",
  "debug_line",
  "shutdown",
  "halt",
  "halted",
  "admit_result",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const HEARTBEAT_PHASES = ["idle", "model_call", "tool_call", "waiting_answer", "compacting"] as const;
export type HeartbeatPhase = (typeof HEARTBEAT_PHASES)[number];

const TurnUsage = z.object({
  uncached_input: z.number().int().nonnegative(),
  cache_write: z.number().int().nonnegative(),
  cache_read: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  effects: z.number().int().nonnegative().optional(),
  wall_time: z.number().nonnegative().optional(),
});

export const Payloads = {
  hello: z.object({
    role: z.enum(CHILD_ROLES),
    pid: z.number().int().positive(),
    version: z.string(),
    standalone: z.boolean(),
    epoch: z.number().int().nonnegative(),
  }),
  ack: z.object({ ref: z.number().int().positive() }),
  heartbeat: z.looseObject({
    turn_active: z.boolean(),
    last_event_id: z.number().int().nonnegative(),
    pid: z.number().int().positive(),
    phase: z.enum(HEARTBEAT_PHASES).optional(),
    phase_since: z.string().optional(),
    turn_usage: TurnUsage.optional(),
    children: z.array(z.number().int().positive()).optional(),
  }),
  session_open: z.object({
    session_id: z.string().min(1),
    jsonl_path: z.string().min(1),
    mode: z.enum(["new", "resume"]),
    workspace: z.string().min(1),
    app_dir: z.string().min(1),
    config_path: z.string().min(1),
    orphans: z.array(z.number().int().positive()).optional(),
  }),
  prompt: z.object({
    text: z.string(),
    note: z.string().optional(),
  }),
  cancel: z.object({ reason: z.string().optional() }),
  continue: z.object({ proceed: z.boolean() }),
  ask_user: z.looseObject({
    kind: z.enum(["question", "continue", "pending"]),
    request_id: z.string().min(1),
    question: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
    allow_multiple: z.boolean().optional(),
    detail: z.string().optional(),
    effect_id: z.string().optional(),
    tool: z.string().optional(),
    summary: z.string().optional(),
    reason: z.string().optional(),
  }),
  answer: z.looseObject({
    request_id: z.string().min(1),
    text: z.string().optional(),
    selected: z.array(z.string()).optional(),
  }),
  event: AgentEventSchema,
  inject: z.object({
    kind: z.enum(["memory", "governance"]),
    text: z.string(),
    memory_ids: z.array(z.string()).optional(),
    prompt_id: z.string().optional(),
    run_ctx: z.string().optional(),
  }),
  resume: z.object({
    reason: z.enum(RESUME_REASONS),
    phase: z.enum(HEARTBEAT_PHASES).optional(),
  }),
  restart_request: z.object({ reason: z.string() }),
  debug_line: z.looseObject({ ts: z.string(), proc: z.enum(PROC_IDS), dom: z.string(), op: z.string() }),
  shutdown: z.object({ reason: z.string().optional() }),
  resolve: z.object({ effect_id: z.string().min(1), decision: z.enum(["allow", "deny"]).optional() }),
  halt: z.object({ reason: z.string().optional() }),
  halted: z.object({
    reason: z.string().optional(),
    in_flight: z.array(z.object({
      effect_id: z.string(),
      kind: z.string(),
      target: z.string(),
      status: z.string(),
    })).default([]),
  }),
  admit_result: z.object({
    status: z.enum(["admitted", "refused"]),
    run_ctx: z.string().optional(),
    exposure: z.array(z.string()).optional(),
    reason: z.string().optional(),
  }),
} as const;

export type PayloadOf<T extends MessageType> = z.infer<(typeof Payloads)[T]>;

export interface IpcMessageOf<T extends MessageType> {
  v: number;
  id: number;
  from: ProcId;
  to: ProcId;
  type: T;
  ts: string;
  run_ctx: string;
  seq: number;
  payload: PayloadOf<T>;
}

/** Discriminated union over the 19 types so `msg.type === "event"` narrows the payload. */
export type IpcMessage<T extends MessageType = MessageType> = { [K in MessageType]: IpcMessageOf<K> }[T];

const EnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.number().int().positive(),
  from: z.enum(PROC_IDS),
  to: z.enum(PROC_IDS),
  type: z.enum(MESSAGE_TYPES),
  ts: z.string().min(1),
  run_ctx: z.string().default(""),
  seq: z.number().int().nonnegative().default(0),
  payload: z.unknown(),
});

export type ValidateResult = { ok: true; msg: IpcMessage } | { ok: false; reason: string };

/** Validates a raw channel object; invalid input is reported, never thrown (HERAV1PROC-IP01 EC-02). */
export function validate(raw: unknown): ValidateResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not an object" };
  const record = raw as Record<string, unknown>;
  if (record["v"] !== PROTOCOL_VERSION) return { ok: false, reason: `protocol version ${String(record["v"])} (expected ${PROTOCOL_VERSION})` };
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const issue = envelope.error.issues[0];
    const path = issue?.path.map(String).join(".") ?? "";
    if (path === "type") return { ok: false, reason: `unknown type '${String(record["type"])}'` };
    return { ok: false, reason: `envelope field ${path || "(root)"}: ${issue?.message ?? "invalid"}` };
  }
  const type = envelope.data.type;
  const payload = Payloads[type].safeParse(envelope.data.payload ?? {});
  if (!payload.success) {
    const issue = payload.error.issues[0];
    return { ok: false, reason: `payload of '${type}' field ${issue?.path.map(String).join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, msg: { ...envelope.data, payload: payload.data } as IpcMessage };
}

export function isType<T extends MessageType>(msg: IpcMessage, type: T): msg is IpcMessage<T> {
  return msg.type === type;
}
