// Canonical, provider-neutral domain types (HERAV1AGNT-SP01 section 3, HERAV1AGNT-IP01 IS-04).
// In-memory names are camelCase; the JSONL wire (events.ts) keeps the V1 snake_case names.

export const PROC_IDS = ["comm", "exec", "sup"] as const;
export type ProcId = (typeof PROC_IDS)[number];

export const ROLE_NAMES = ["generating", "compacting", "supervisor", "memory"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
export type RoleOrAlias = RoleName | "websearch";

export const PROVIDER_IDS = ["openai", "anthropic", "zai", "scripted"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const CHILD_ROLES = ["executor", "supervisor"] as const;
export type ChildRole = (typeof CHILD_ROLES)[number];
export type ProcessRole = "communicator" | ChildRole | "viewer";

export const TOOL_CALL_FINISHED_STATUSES = ["ok", "error", "timed_out", "unknown", "cancelled", "blocked"] as const;
export const TOOL_CALL_STATUSES = ["pending", ...TOOL_CALL_FINISHED_STATUSES] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export const STOP_REASONS = ["end", "tool_calls", "max_output", "refusal", "pause", "cancelled"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface ToolCall {
  id: string;
  name: string;
  argsJson: string;
  args?: Record<string, unknown>;
  status: ToolCallStatus;
  result?: string;
}

export interface ThinkingBlock {
  provider: ProviderId;
  payload: unknown;
}

export interface Usage {
  uncachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const ZERO_USAGE: Readonly<Usage> = Object.freeze({ uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export const ORIGIN_KINDS = ["user", "tool", "model", "memory", "file", "web", "system"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

export interface Origin {
  kind: OriginKind;
  ref: string | string[];
}

export interface Message {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  thinking?: ThinkingBlock[];
  toolCallId?: string;
  usage?: Usage;
  origin?: Origin;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export const UNTRUSTED_CONTENT_OPEN = '<untrusted_content origin="';
export const UNTRUSTED_CONTENT_CLOSE = "</untrusted_content>";

export const WRAPPED_TOOLS = new Set([
  "read_file",
  "list_dir",
  "search",
  "run_command",
  "command_status",
  "search_web",
  "read_url_content",
  "view_content_chunk",
  "trajectory_search",
]);

export function procIdOf(role: ProcessRole): ProcId {
  switch (role) {
    case "executor":
      return "exec";
    case "supervisor":
      return "sup";
    default:
      return "comm";
  }
}
