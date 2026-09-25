// EventTranslator (HERAV1ACP-SP01 FR-06, FR-07; HERAV1ACP-IP01 IS-04). Port of V1 translator.py with the V2 mapping:
// exhaustive over the 14 AgentEvent types - every type yields its notifications or a documented omission (stderr line).
// Owns the messageId rotation (one logical message per turn, DD-06).

import type { CostLedger } from "../cli/cost.ts";
import type { AgentEvent } from "../events.ts";
import type { Projection } from "../session/projection.ts";

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

/** 15 tools → ACP kinds (FR-07). */
export const TOOL_KINDS: Record<string, ToolKind> = {
  read_file: "read",
  list_dir: "read",
  view_content_chunk: "read",
  search: "search",
  trajectory_search: "search",
  edit: "edit",
  multi_edit: "edit",
  write_to_file: "edit",
  run_command: "execute",
  command_status: "execute",
  search_web: "fetch",
  read_url_content: "fetch",
  todo_list: "think",
  skill: "other",
  ask_user_question: "other",
};

const PRIMARY_ARGUMENT_KEYS = ["CommandLine", "file_path", "TargetFile", "AbsolutePath", "DirectoryPath", "SearchPath", "Url", "Query", "query", "question", "SkillName", "document_id", "ID"];

export type Update = Record<string, unknown> & { sessionUpdate: string };

export function primaryArgument(args: Record<string, unknown>): string {
  for (const key of PRIMARY_ARGUMENT_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const v of Object.values(args)) if (typeof v === "string" && v.length > 0) return v;
  return "";
}

export interface TranslatorOptions {
  ledger: CostLedger;
  /** generating model context window (tokens), 0 when unknown */
  contextWindow: number;
  replaying?: boolean;
  stderr: (line: string) => void;
}

export class EventTranslator {
  private turnCounter = 0;
  messageId = "msg_0";
  private readonly replaying: boolean;
  /** tool name per tool call id (the finished event carries only the id) */
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly opts: TranslatorOptions) {
    this.replaying = opts.replaying ?? false;
  }

  translate(event: AgentEvent): Update[] {
    switch (event.type) {
      case "turn_started":
        this.turnCounter++;
        this.messageId = `msg_${this.turnCounter}`;
        return [];
      case "text_delta":
        return [{ sessionUpdate: "agent_message_chunk", messageId: this.messageId, content: { type: "text", text: event.text } }];
      case "thinking_delta":
        return [{ sessionUpdate: "agent_thought_chunk", messageId: this.messageId, content: { type: "text", text: event.text } }];
      case "tool_call_requested": {
        const argument = primaryArgument(event.args);
        const title = argument.length > 0 ? `${event.tool}: ${argument}` : event.tool;
        this.toolNames.set(event.id, event.tool);
        return [{ sessionUpdate: "tool_call", toolCallId: event.id, title: title.slice(0, 200), kind: TOOL_KINDS[event.tool] ?? "other", status: "pending" }];
      }
      case "tool_call_finished": {
        const status = event.status === "ok" ? "completed" : "failed";
        const updates: Update[] = [{ sessionUpdate: "tool_call_update", toolCallId: event.id, status, content: [{ type: "content", content: { type: "text", text: event.result } }] }];
        if (event.status === "ok" && this.toolNames.get(event.id) === "todo_list") {
          const plan = todoPlan(event.result);
          if (plan !== undefined) updates.push(plan);
        }
        this.toolNames.delete(event.id);
        return updates;
      }
      case "turn_finished":
        if (event.role !== "generating") return []; // supervisor, memory, communicator: ledger only (EC-12)
        return [{ sessionUpdate: "usage_update", used: event.uncached_input + event.cache_read + event.cache_write + event.output, size: this.opts.contextWindow, cost: { amount: this.opts.ledger.totalUsd, currency: "USD" } }];
      case "user_message":
        if (!this.replaying) return []; // live: the client owns the user's message
        return [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: event.content } }];
      case "error": {
        const prefix = event.severity === "warning" ? "WARNING: " : event.severity === "notice" ? "NOTICE: " : "";
        return [{ sessionUpdate: "agent_message_chunk", messageId: this.messageId, content: { type: "text", text: `${prefix}${event.message}` } }];
      }
      case "supervisor_intervention":
        if (event.kind === "governance_note") return [{ sessionUpdate: "agent_thought_chunk", messageId: this.messageId, content: { type: "text", text: `SUPERVISOR: ${event.text}` } }];
        return [{ sessionUpdate: "agent_message_chunk", messageId: this.messageId, content: { type: "text", text: `SUPERVISOR: ${event.kind === "guard_block" ? event.text : `${event.kind.replace("_", " ")} - ${event.text}`}` } }];
      case "executor_resumed":
        return [{ sessionUpdate: "agent_message_chunk", messageId: this.messageId, content: { type: "text", text: `NOTICE: executor resumed (${event.reason})` } }];
      case "checkpoint_created":
        this.opts.stderr(`  omitted: checkpoint_created (${event.truncated_messages} message${event.truncated_messages === 1 ? "" : "s"} compacted) - no v1 ACP mapping.`);
        return [];
      case "memory_injected":
        this.opts.stderr(`  omitted: memory_injected (${event.memory_ids.length} memories).`);
        return [];
      case "prompt_step":
        this.opts.stderr(`  omitted: prompt_step (step ${event.index}/${event.total}) - headless-only event; its presence in ACP mode indicates a bug.`);
        return [];
      case "session_started":
        return []; // session-file-only environment record
      case "halted":
        return [{ sessionUpdate: "agent_message_chunk", messageId: this.messageId, content: { type: "text", text: `HALTED: ${event.reason ?? "unknown"}${event.in_flight.length > 0 ? ` (${event.in_flight.length} in-flight effects)` : ""}` } }];
      case "run_ended":
        return [{ sessionUpdate: "agent_message_chunk", messageId: this.messageId, content: { type: "text", text: `RUN ENDED: ${event.reason ?? "unknown"}` } }];
      default:
        return [];
    }
  }

  /** session/load replay (FR-04): user and assistant chunks, tool_call + tool_call_update pairs, final plan. */
  replay(projection: Projection): Update[] {
    const out: Update[] = [];
    for (const event of projection.events) {
      if (event.type === "turn_finished" || event.type === "error" || event.type === "thinking_delta" || event.type === "supervisor_intervention" || event.type === "executor_resumed") continue;
      out.push(...this.translate(event));
    }
    if (projection.todoJson !== undefined) {
      const plan = todoPlan(projection.todoJson);
      if (plan !== undefined) out.push(plan);
    }
    return out;
  }
}

/** DD-08: the todo_list result (`{"todos": [...]}`, byte-verbatim in the session) additionally maps to a whole-plan update (entries content/priority/status 1:1). */
export function todoPlan(result: string): Update | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return undefined;
  }
  const entries = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { todos?: unknown }).todos) ? (parsed as { todos: unknown[] }).todos : undefined;
  if (entries === undefined) return undefined;
  const items = entries as Array<Record<string, unknown>>;
  return {
    sessionUpdate: "plan",
    entries: items.map((item) => ({ content: typeof item["content"] === "string" ? item["content"] : "", priority: typeof item["priority"] === "string" ? item["priority"] : "medium", status: typeof item["status"] === "string" ? item["status"] : "pending" })),
  };
}
