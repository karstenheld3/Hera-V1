// Session JSONL projection (HERAV1EXEC-SP01 FR-05, IG-02; HERAV1EXEC-IP01 IS-02). One reader for the Executor's resume,
// the Communicator's --resume display, and the CLI cost ledger rebuild. Port of V1 session.py projection.
// The event log is the single source of truth: system prompt, tools, config, conversation, checkpoint, thinking payloads.

import { readFileSync } from "node:fs";
import { fromJsonl, type AgentEvent } from "../events.ts";
import { renderToolResult } from "../executor/injection.ts";
import type { Message, Origin, ProviderId, ThinkingBlock, TodoItem, ToolCall, ToolDefinition, Usage } from "../models.ts";

export interface SessionHeader {
  systemPrompt: string;
  toolDefinitions: ToolDefinition[];
  configSnapshot: Record<string, unknown>;
  definition_hash: string;
}

export interface TurnUsageRecord {
  role: string;
  usage: Usage;
  costUsd: number | null | undefined;
  stopReason: string | undefined;
}

export interface Projection {
  /** undefined for a legacy file whose first line is not session_started */
  header: SessionHeader | undefined;
  legacy: boolean;
  messages: Message[];
  todo: TodoItem[] | undefined;
  /** the last todo_list result text byte-verbatim (IG-01) */
  todoJson: string | undefined;
  turns: TurnUsageRecord[];
  events: AgentEvent[];
  warnings: string[];
  /** a user_message without a matching turn_finished at the end of the file (crash tail) */
  incompleteTurn: { content: string; messagesDropped: number } | undefined;
  /** tool_call_requested without a matching tool_call_finished at the end of the file (crash recovery, H-08) */
  openToolCalls: string[];
  completedTurns: number;
  lineCount: number;
  corruptLines: number;
}

interface PendingAssistant {
  content: string;
  toolCalls: ToolCall[];
  pushed: boolean;
  /** the pushed message, so later tool calls of the same response (interleaved with results) join it */
  message?: Message;
}

/** Reads and projects a session file; corrupt lines are skipped with a warning (a truncated last line is the crash tail). */
export function projectSession(path: string): Projection {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const events: AgentEvent[] = [];
  const warnings: string[] = [];
  let corrupt = 0;
  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      events.push(fromJsonl(line, i + 1));
    } catch (error) {
      corrupt++;
      if (i === lines.length - 1) warnings.push(`WARNING: last line ${i + 1} of the session file is truncated (crash tail) - ignored.`);
      else warnings.push(`WARNING: session line ${i + 1} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const projection = projectEvents(events);
  projection.warnings.unshift(...warnings);
  projection.lineCount = lines.length;
  projection.corruptLines = corrupt;
  return projection;
}

export function projectEvents(events: AgentEvent[]): Projection {
  const out: Projection = { header: undefined, legacy: false, messages: [], todo: undefined, todoJson: undefined, turns: [], events, warnings: [], incompleteTurn: undefined, completedTurns: 0, lineCount: events.length, corruptLines: 0, openToolCalls: [] };
  const first = events[0];
  if (first !== undefined && first.type === "session_started") {
    out.header = { systemPrompt: first.system_prompt, toolDefinitions: first.tool_definitions.map((d): ToolDefinition => ({ name: typeof d["name"] === "string" ? d["name"] : "", description: typeof d["description"] === "string" ? d["description"] : "", parameters: (d["parameters"] ?? {}) as Record<string, unknown> })), configSnapshot: first.config_snapshot, definition_hash: first.definition_hash };
  } else {
    out.legacy = true;
    out.warnings.push("WARNING: legacy session file (first line is not session_started) - the system prompt is assembled from disk.");
  }
  let pending: PendingAssistant | undefined;
  let turnStartIndex: number | undefined;
  let turnUserContent = "";
  let turnPromptId = "";
  const toolNames = new Map<string, string>();
  const toolCallIndex = new Map<string, ToolCall>();
  const flushPending = (): void => {
    if (pending === undefined) return;
    if (!pending.pushed && (pending.content.length > 0 || pending.toolCalls.length > 0)) {
      const message: Message = { role: "assistant", content: pending.content, toolCalls: pending.toolCalls, origin: { kind: "model", ref: turnPromptId } };
      out.messages.push(message);
      pending.pushed = true;
      pending.message = message;
    }
  };
  for (const event of events) {
    switch (event.type) {
      case "user_message":
        if (turnStartIndex !== undefined) {
          // a turn without turn_finished before this one: keep what completed (tool results are on disk), drop nothing
          flushPending();
        }
        turnStartIndex = out.messages.length;
        turnUserContent = event.content;
        turnPromptId = event.prompt_id ?? "";
        out.messages.push({ role: "user", content: event.content, origin: { kind: "user", ref: turnPromptId } });
        pending = { content: "", toolCalls: [], pushed: false };
        break;
      case "text_delta":
        if (pending === undefined || pending.pushed) pending = { content: "", toolCalls: [], pushed: false };
        pending.content += event.text;
        break;
      case "thinking_delta":
        break;
      case "tool_call_requested": {
        toolNames.set(event.id, event.tool);
        const call: ToolCall = { id: event.id, name: event.tool, argsJson: event.args_json ?? JSON.stringify(event.args), args: event.args, status: "pending" };
        toolCallIndex.set(event.id, call);
        if (pending !== undefined && pending.pushed && pending.message !== undefined && pending.content.length === 0) {
          // no text since the last tool result: the call belongs to the same model response (sequential execution)
          pending.message.toolCalls = [...(pending.message.toolCalls ?? []), call];
          pending.toolCalls.push(call);
          break;
        }
        if (pending === undefined || pending.pushed) pending = { content: "", toolCalls: [], pushed: false };
        pending.toolCalls.push(call);
        break;
      }
      case "tool_call_finished": {
        flushPending();
        const call = toolCallIndex.get(event.id);
        if (call !== undefined) {
          call.status = event.status;
          call.result = event.result;
        }
        const toolName = toolNames.get(event.id) ?? "unknown";
        out.messages.push({ role: "tool", content: renderToolResult(event.result, toolName, event.id), toolCallId: event.id, origin: { kind: "tool", ref: event.id } });
        if (toolNames.get(event.id) === "todo_list" && event.status === "ok") {
          try {
            const parsed = JSON.parse(event.result) as { todos?: TodoItem[] };
            if (Array.isArray(parsed.todos)) {
              out.todo = parsed.todos;
              out.todoJson = event.result;
            }
          } catch {
            /* not a todo payload */
          }
        }
        // keep the pushed assistant open (content cleared) so a following tool call without text joins it
        if (pending !== undefined) pending.content = "";
        break;
      }
      case "turn_finished": {
        if (event.role === "generating") {
          flushPending();
          const usage: Usage = { uncachedInput: event.uncached_input, cacheWrite: event.cache_write, cacheRead: event.cache_read, output: event.output };
          let last: Message | undefined;
          for (let i = out.messages.length - 1; i >= 0; i--) {
            if (out.messages[i]!.role === "assistant") { last = out.messages[i]; break; }
          }
          if (last !== undefined) {
            last.usage = usage;
            if (event.thinking_payloads !== undefined && event.thinking_payloads.length > 0) last.thinking = event.thinking_payloads.map((t) => ({ provider: t.provider as ProviderId, payload: t.payload }) as ThinkingBlock);
          }
          turnStartIndex = undefined;
          out.completedTurns++;
          pending = undefined;
        }
        out.turns.push({ role: event.role, usage: { uncachedInput: event.uncached_input, cacheWrite: event.cache_write, cacheRead: event.cache_read, output: event.output }, costUsd: event.cost_usd, stopReason: event.stop_reason });
        break;
      }
      case "checkpoint_created": {
        flushPending();
        const kept = Math.min(event.kept_messages, out.messages.length);
        const tail = kept > 0 ? out.messages.slice(-kept) : [];
        out.messages = [{ role: "user", content: event.text, origin: { kind: "model", ref: event.prompt_id ?? "compaction" } as Origin }, ...tail];
        if (turnStartIndex !== undefined) turnStartIndex = Math.min(turnStartIndex, out.messages.length);
        break;
      }
      default:
        break;
    }
  }
  // H-08 crash recovery: collect tool_call_requested ids with no matching tool_call_finished
  const finishedIds = new Set<string>();
  for (const e of events) {
    if (e.type === "tool_call_finished") finishedIds.add(e.id);
  }
  for (const e of events) {
    if (e.type === "tool_call_requested" && !finishedIds.has(e.id)) out.openToolCalls.push(e.id);
  }
  if (turnStartIndex !== undefined) {
    // crash tail: the in-flight turn is dropped (IG-02); the Communicator re-sends its prompt on resume
    const dropped = out.messages.length - turnStartIndex;
    out.messages = out.messages.slice(0, turnStartIndex);
    out.incompleteTurn = { content: turnUserContent, messagesDropped: dropped };
  }
  return out;
}

/** Total usage per role across the projection (cost ledger rebuild). */
export function usageByRole(projection: Projection): Record<string, { usage: Usage; costUsd: number; unknownCost: boolean; calls: number }> {
  const out: Record<string, { usage: Usage; costUsd: number; unknownCost: boolean; calls: number }> = {};
  for (const t of projection.turns) {
    const entry = out[t.role] ?? { usage: { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0, unknownCost: false, calls: 0 };
    entry.calls++;
    entry.usage = { uncachedInput: entry.usage.uncachedInput + t.usage.uncachedInput, cacheWrite: entry.usage.cacheWrite + t.usage.cacheWrite, cacheRead: entry.usage.cacheRead + t.usage.cacheRead, output: entry.usage.output + t.usage.output };
    if (typeof t.costUsd === "number") entry.costUsd += t.costUsd;
    else entry.unknownCost = true;
    out[t.role] = entry;
  }
  return out;
}
