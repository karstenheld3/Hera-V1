// Z.ai adapter over Chat Completions on the openai SDK (HERAV1PRVD-SP01 FR-04; HERAV1PRVD-IP01 IS-05). Port of V1
// zai_adapter.py. Z.ai-specific parameters (thinking, reasoning_effort) travel in the request body via zaiExtraBody();
// no model-name special cases live here - the registry method decides.

import type { KeyHandle } from "../config/keys.ts";
import type { ResolvedRole } from "../config/load.ts";
import { ProviderError } from "../errors.ts";
import type { Message, ProviderId, StopReason, ThinkingBlock, ToolCall, Usage } from "../models.ts";
import { toChatTool, type AdapterDelta, type ProviderAdapter, type TurnRequest, type WebSearchResult } from "./base.ts";
import type { DebugDumper } from "./debugdump.ts";
import { toProviderError, withRetries } from "./retry.ts";

export const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4/";
export const ZAI_TIMEOUT_MS = 120_000;

type Params = Record<string, unknown>;

export interface ChatClientLike {
  chat: { completions: { create(params: Params, options?: Params): Promise<unknown> } };
}

export type ChatClientFactory = (key: KeyHandle) => Promise<ChatClientLike>;

const defaultFactory: ChatClientFactory = async (key) => {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: key.reveal(), baseURL: ZAI_BASE_URL, timeout: ZAI_TIMEOUT_MS, maxRetries: 0 }) as unknown as ChatClientLike;
};

/** Canonical messages → Chat Completions messages; the system prompt is the first message; zai reasoning is resent. */
export function buildMessages(system: string, messages: Message[]): Params[] {
  const out: Params[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const msg: Params = { role: "assistant" };
      let reasoning = "";
      for (const t of m.thinking ?? []) if (t.provider === "zai") reasoning += String((t.payload as { reasoning_content?: string }).reasoning_content ?? "");
      if (reasoning.length > 0) msg["reasoning_content"] = reasoning;
      if (m.content.length > 0) msg["content"] = m.content;
      if (m.toolCalls !== undefined && m.toolCalls.length > 0) msg["tool_calls"] = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argsJson } }));
      out.push(msg);
    } else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

/** The Z.ai extra body per registry method; the one place the openai SDK carries non-OpenAI fields (spread into params). */
export function zaiExtraBody(role: ResolvedRole): Params {
  const p = role.params;
  if (p.method === "reasoning_effort") return { reasoning_effort: p.reasoning_effort, thinking: { type: "enabled", clear_thinking: false } };
  if (p.method === "thinking") return { thinking: { type: p.thinking_budget > 0 ? "enabled" : "disabled", clear_thinking: false } };
  if (p.method === "temperature") return { temperature: p.temperature };
  return {};
}

export function buildChatRequest(req: TurnRequest): Params {
  const params: Params = { model: req.role.modelId, messages: buildMessages(req.system, req.messages), stream: true, stream_options: { include_usage: true }, max_tokens: req.role.maxOutput, ...zaiExtraBody(req.role) };
  if (req.tools.length > 0) {
    params["tools"] = req.tools.map(toChatTool);
    params["tool_choice"] = "auto";
  }
  return params;
}

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

export function normalizeUsage(usage: UsageLike): Usage {
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return { uncachedInput: Math.max(0, prompt - cached), cacheWrite: 0, cacheRead: cached, output: usage.completion_tokens ?? 0 };
}

export function mapFinishReason(raw: string | null | undefined, toolCalls: number): StopReason {
  switch (raw) {
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "max_output";
    case "content_filter":
      return "refusal";
    case "stop":
    default:
      return toolCalls > 0 ? "tool_calls" : "end";
  }
}

interface ToolAcc {
  id: string;
  name: string;
  arguments: string;
}

export class ZaiAdapter implements ProviderAdapter {
  readonly provider: ProviderId = "zai";
  private client: ChatClientLike | undefined;

  constructor(
    private readonly key: KeyHandle,
    private readonly debug: DebugDumper | undefined = undefined,
    private readonly factory: ChatClientFactory = defaultFactory,
  ) {}

  private async clientOrCreate(): Promise<ChatClientLike> {
    if (this.client === undefined) this.client = await this.factory(this.key);
    return this.client;
  }

  async *streamTurn(req: TurnRequest, signal?: AbortSignal): AsyncIterable<AdapterDelta> {
    const request = buildChatRequest(req);
    (req.debug ?? this.debug)?.request(req.role.name, request);
    const notices: string[] = [];
    const stream = await withRetries(
      async () => {
        const client = await this.clientOrCreate();
        return (await client.chat.completions.create(request, signal !== undefined ? { signal } : undefined)) as AsyncIterable<Record<string, unknown>>;
      },
      { provider: "zai", model: req.role.modelId, onNotice: (t) => notices.push(t) },
    );
    for (const n of notices) yield { kind: "notice", text: n };
    let reasoning = "";
    const tools = new Map<number, ToolAcc>();
    let usage: UsageLike | undefined;
    let finish: string | null | undefined;
    let cancelled = false;
    try {
      for await (const chunk of stream) {
        if (signal?.aborted === true) {
          cancelled = true;
          break;
        }
        const u = chunk["usage"] as UsageLike | null | undefined;
        if (u !== null && u !== undefined) usage = u;
        const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        if (choice === undefined) continue;
        if (typeof choice["finish_reason"] === "string") finish = choice["finish_reason"];
        const delta = (choice["delta"] as Record<string, unknown> | undefined) ?? {};
        const rc = delta["reasoning_content"];
        if (typeof rc === "string" && rc.length > 0) {
          reasoning += rc;
          yield { kind: "thinking", text: rc };
        }
        const content = delta["content"];
        if (typeof content === "string" && content.length > 0) yield { kind: "text", text: content };
        for (const tc of (delta["tool_calls"] as Array<Record<string, unknown>> | undefined) ?? []) {
          const index = typeof tc["index"] === "number" ? tc["index"] : tools.size;
          const acc = tools.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof tc["id"] === "string" && tc["id"].length > 0) acc.id = tc["id"];
          const fn = tc["function"] as Record<string, unknown> | undefined;
          if (typeof fn?.["name"] === "string" && fn["name"].length > 0) acc.name = fn["name"];
          if (typeof fn?.["arguments"] === "string") acc.arguments += fn["arguments"];
          tools.set(index, acc);
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal?.aborted === true) cancelled = true;
      else throw toProviderError(error, "zai", req.role.modelId);
    }
    const thinkingPayloads: ThinkingBlock[] = reasoning.length > 0 ? [{ provider: "zai", payload: { reasoning_content: reasoning } }] : [];
    if (cancelled) {
      yield { kind: "usage", usage: normalizeUsage(usage ?? {}), stopReason: "cancelled", thinkingPayloads };
      return;
    }
    let toolCalls = 0;
    for (const index of [...tools.keys()].sort((a, b) => a - b)) {
      const acc = tools.get(index) as ToolAcc;
      toolCalls++;
      const argsJson = acc.arguments.length > 0 ? acc.arguments : "{}";
      const call: ToolCall = { id: acc.id.length > 0 ? acc.id : `call_${index}`, name: acc.name, argsJson, status: "pending" };
      try {
        call.args = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        /* raw args kept */
      }
      yield { kind: "tool_call", toolCall: call };
    }
    (req.debug ?? this.debug)?.response(req.role.name, { reasoning_content: reasoning, tool_calls: [...tools.values()], usage, finish_reason: finish });
    if (usage === undefined) yield { kind: "notice", text: "Z.ai stream ended without a usage chunk - tokens recorded as 0." };
    yield { kind: "usage", usage: normalizeUsage(usage ?? {}), stopReason: mapFinishReason(finish, toolCalls), thinkingPayloads };
  }

  supportsWebSearch(): boolean {
    return true;
  }

  /** Z.ai web search via the `web_search` tool of Chat Completions; results come back in `web_search` [ASSUMED, DD-05]. */
  async webSearch(query: string, role: ResolvedRole, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const client = await this.clientOrCreate();
    let response: Record<string, unknown>;
    try {
      response = (await client.chat.completions.create(
        { model: role.modelId, messages: [{ role: "user", content: `Search the web for: ${query}` }], tools: [{ type: "web_search", web_search: { enable: true, search_result: true, search_query: query } }], max_tokens: Math.min(role.maxOutput, 2048) },
        signal !== undefined ? { signal } : undefined,
      )) as Record<string, unknown>;
    } catch (error) {
      throw toProviderError(error, "zai", role.modelId);
    }
    const results: WebSearchResult[] = [];
    for (const entry of (response["web_search"] as Array<Record<string, unknown>> | undefined) ?? []) {
      const url = String(entry["link"] ?? entry["url"] ?? "");
      if (url.length > 0) results.push({ title: String(entry["title"] ?? url), url, snippet: String(entry["content"] ?? "").slice(0, 300) });
    }
    if (results.length === 0) {
      const choices = response["choices"] as Array<{ message?: { content?: string } }> | undefined;
      const text = choices?.[0]?.message?.content ?? "";
      if (text.length > 0) results.push({ title: "Web search response", url: "", snippet: text.slice(0, 300) });
    }
    return results;
  }
}
