// Adapter contract (HERAV1PRVD-SP01 FR-01; HERAV1PRVD-IP01 IS-01). Every adapter streams the same canonical deltas;
// the final delta is always `usage` (even after cancellation) so the Executor reads the stop reason in one place.

import type { ResolvedRole } from "../config/load.ts";
import type { Message, ProviderId, StopReason, ThinkingBlock, ToolCall, ToolDefinition, Usage } from "../models.ts";
import type { DebugDumper } from "./debugdump.ts";

export type { StopReason };

export type AdapterDelta =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; toolCall: ToolCall }
  | { kind: "notice"; text: string }
  | { kind: "usage"; usage: Usage; stopReason: StopReason; thinkingPayloads: ThinkingBlock[] };

export interface TurnRequest {
  system: string;
  tools: ToolDefinition[];
  messages: Message[];
  role: ResolvedRole;
  debug?: DebugDumper | undefined;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  streamTurn(req: TurnRequest, signal?: AbortSignal): AsyncIterable<AdapterDelta>;
  supportsWebSearch(): boolean;
  webSearch(query: string, role: ResolvedRole, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

/** Responses API: flat `{type, name, description, parameters}`. */
export function toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Messages API: `{name, description, input_schema}`. */
export function toMessagesTool(tool: ToolDefinition): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

/** Chat Completions API: nested `{type, function: {name, description, parameters}}`. */
export function toChatTool(tool: ToolDefinition): Record<string, unknown> {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

/** Human-readable provider name for notices and errors. */
export function providerDisplayName(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "zai":
      return "Z.ai";
    default:
      return "Scripted";
  }
}
