// Anthropic adapter over the Messages API (HERAV1PRVD-SP01 FR-03; HERAV1PRVD-IP01 IS-04). Port of V1 anthropic_adapter.py.
// Cache breakpoints: last tool and the system block; thinking blocks are resent with their signatures.

import type { KeyHandle } from "../config/keys.ts";
import type { ResolvedRole } from "../config/load.ts";
import { ProviderError } from "../errors.ts";
import type { Message, ProviderId, StopReason, ThinkingBlock, ToolCall, Usage } from "../models.ts";
import { toMessagesTool, type AdapterDelta, type ProviderAdapter, type TurnRequest, type WebSearchResult } from "./base.ts";
import type { DebugDumper } from "./debugdump.ts";
import { toProviderError, withRetries } from "./retry.ts";

export const ANTHROPIC_TIMEOUT_MS = 120_000;
export const WEB_SEARCH_TOOL_TYPE = "web_search_20260318";
const EPHEMERAL = { type: "ephemeral" } as const;

type Params = Record<string, unknown>;

export interface AnthropicClientLike {
  messages: { create(params: Params, options?: Params): Promise<unknown> };
}

export type AnthropicClientFactory = (key: KeyHandle) => Promise<AnthropicClientLike>;

const defaultFactory: AnthropicClientFactory = async (key) => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey: key.reveal(), timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: 0 }) as unknown as AnthropicClientLike;
};

/** Canonical messages → Messages API; consecutive user / tool_result blocks merge (alternation rule). */
export function buildMessages(messages: Message[]): Array<{ role: "user" | "assistant"; content: Params[] }> {
  const out: Array<{ role: "user" | "assistant"; content: Params[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const block: Params = { type: "text", text: m.content };
      const last = out[out.length - 1];
      if (last !== undefined && last.role === "user") last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant") {
      const blocks: Params[] = [];
      for (const t of m.thinking ?? []) if (t.provider === "anthropic") blocks.push(t.payload as Params);
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.argsJson);
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      const block: Params = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last !== undefined && last.role === "user" && last.content[0]?.["type"] === "tool_result") last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

export function buildTools(tools: TurnRequest["tools"]): Params[] {
  const rendered = tools.map(toMessagesTool);
  const last = rendered[rendered.length - 1];
  if (last !== undefined) last["cache_control"] = EPHEMERAL;
  return rendered;
}

/** Registry method → request fields (V1 lines 68-76 unchanged in logic). */
export function buildRequestParams(role: ResolvedRole): Params {
  const params: Params = { max_tokens: role.maxOutput };
  const p = role.params;
  if (p.method === "thinking") {
    if (p.thinking_budget >= 1024) {
      params["thinking"] = { type: "enabled", budget_tokens: p.thinking_budget };
      params["max_tokens"] = Math.max(role.maxOutput, p.thinking_budget + 2048);
    }
  } else if (p.method === "adaptive_thinking") {
    params["thinking"] = { type: "adaptive" };
    params["output_config"] = { effort: p.effort };
  } else if (p.method === "effort") {
    params["output_config"] = { effort: p.effort };
  } else if (p.method === "temperature") {
    params["temperature"] = p.temperature;
  }
  return params;
}

export function buildMessagesRequest(req: TurnRequest): { params: Params; options: Params | undefined } {
  const params: Params = {
    model: req.role.modelId,
    system: [{ type: "text", text: req.system, cache_control: EPHEMERAL }],
    messages: buildMessages(req.messages),
    tool_choice: { type: "auto" },
    stream: true,
    ...buildRequestParams(req.role),
  };
  if (req.tools.length > 0) params["tools"] = buildTools(req.tools);
  const beta = req.role.params.method === "effort" ? req.role.params.beta : undefined;
  const options = beta !== undefined ? { headers: { "anthropic-beta": beta } } : undefined;
  return { params, options };
}

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** DD-07: uncached_input is the provider's input_tokens (already excludes cache); cache_write and cache_read are separate. */
export function normalizeUsage(usage: UsageLike): Usage {
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return { uncachedInput: usage.input_tokens ?? 0, cacheWrite: write, cacheRead: read, output: usage.output_tokens ?? 0 };
}

export function mapStopReason(raw: string | null | undefined, stopDetails?: unknown): { stop: StopReason; notice?: string } {
  switch (raw) {
    case "tool_use":
      return { stop: "tool_calls" };
    case "max_tokens":
      return { stop: "max_output" };
    case "model_context_window_exceeded":
      return { stop: "max_output", notice: "Anthropic stopped: model context window exceeded" };
    case "refusal":
      return { stop: "refusal", notice: `Anthropic refused to continue${stopDetails !== undefined ? ` (${JSON.stringify(stopDetails)})` : ""}` };
    case "pause_turn":
      return { stop: "pause" };
    case "end_turn":
    case "stop_sequence":
    default:
      return { stop: "end" };
  }
}

interface BlockAcc {
  type: string;
  id?: string;
  name?: string;
  text: string;
  thinking: string;
  json: string;
  signature?: string;
  data?: string;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider: ProviderId = "anthropic";
  private client: AnthropicClientLike | undefined;

  constructor(
    private readonly key: KeyHandle,
    private readonly debug: DebugDumper | undefined = undefined,
    private readonly factory: AnthropicClientFactory = defaultFactory,
  ) {}

  private async clientOrCreate(): Promise<AnthropicClientLike> {
    if (this.client === undefined) this.client = await this.factory(this.key);
    return this.client;
  }

  async *streamTurn(req: TurnRequest, signal?: AbortSignal): AsyncIterable<AdapterDelta> {
    const { params, options } = buildMessagesRequest(req);
    (req.debug ?? this.debug)?.request(req.role.name, params);
    const notices: string[] = [];
    const stream = await withRetries(
      async () => {
        const client = await this.clientOrCreate();
        return (await client.messages.create(params, { ...(options ?? {}), ...(signal !== undefined ? { signal } : {}) })) as AsyncIterable<Record<string, unknown>>;
      },
      { provider: "anthropic", model: req.role.modelId, onNotice: (t) => notices.push(t) },
    );
    for (const n of notices) yield { kind: "notice", text: n };
    const blocks = new Map<number, BlockAcc>();
    const thinkingPayloads: ThinkingBlock[] = [];
    let usage: UsageLike = {};
    let stopRaw: string | null | undefined;
    let stopDetails: unknown;
    let cancelled = false;
    let toolCalls = 0;
    const laterNotices: string[] = [];
    const finishBlock = (acc: BlockAcc): AdapterDelta | undefined => {
      if (acc.type === "tool_use") {
        toolCalls++;
        const argsJson = acc.json.length > 0 ? acc.json : "{}";
        const call: ToolCall = { id: acc.id ?? `toolu_${crypto.randomUUID().slice(0, 8)}`, name: acc.name ?? "", argsJson, status: "pending" };
        try {
          call.args = JSON.parse(argsJson) as Record<string, unknown>;
        } catch {
          /* raw args kept */
        }
        return { kind: "tool_call", toolCall: call };
      }
      if (acc.type === "thinking") {
        if (acc.signature === undefined || acc.signature.length === 0) laterNotices.push("Anthropic thinking block arrived without a signature - dropped from the resend set.");
        else thinkingPayloads.push({ provider: "anthropic", payload: { type: "thinking", thinking: acc.thinking, signature: acc.signature } });
      } else if (acc.type === "redacted_thinking") {
        thinkingPayloads.push({ provider: "anthropic", payload: { type: "redacted_thinking", data: acc.data ?? "" } });
      }
      return undefined;
    };
    try {
      for await (const event of stream) {
        if (signal?.aborted === true) {
          cancelled = true;
          break;
        }
        const type = event["type"] as string;
        if (type === "message_start") {
          const message = event["message"] as { usage?: UsageLike } | undefined;
          usage = { ...usage, ...(message?.usage ?? {}) };
        } else if (type === "content_block_start") {
          const cb = event["content_block"] as Record<string, unknown>;
          const index = event["index"] as number;
          const acc: BlockAcc = { type: String(cb["type"]), text: "", thinking: "", json: "" };
          if (typeof cb["id"] === "string") acc.id = cb["id"];
          if (typeof cb["name"] === "string") acc.name = cb["name"];
          if (typeof cb["data"] === "string") acc.data = cb["data"];
          blocks.set(index, acc);
        } else if (type === "content_block_delta") {
          const acc = blocks.get(event["index"] as number);
          const delta = event["delta"] as Record<string, unknown>;
          const dt = delta["type"];
          if (dt === "text_delta") {
            const text = String(delta["text"] ?? "");
            if (acc !== undefined) acc.text += text;
            yield { kind: "text", text };
          } else if (dt === "thinking_delta") {
            const text = String(delta["thinking"] ?? "");
            if (acc !== undefined) acc.thinking += text;
            yield { kind: "thinking", text };
          } else if (dt === "input_json_delta") {
            if (acc !== undefined) acc.json += String(delta["partial_json"] ?? "");
          } else if (dt === "signature_delta") {
            if (acc !== undefined) acc.signature = (acc.signature ?? "") + String(delta["signature"] ?? "");
          }
        } else if (type === "content_block_stop") {
          const index = event["index"] as number;
          const acc = blocks.get(index);
          if (acc !== undefined) {
            const delta = finishBlock(acc);
            blocks.delete(index);
            if (delta !== undefined) yield delta;
          }
        } else if (type === "message_delta") {
          const d = event["delta"] as Record<string, unknown> | undefined;
          stopRaw = (d?.["stop_reason"] as string | null | undefined) ?? stopRaw;
          if (d?.["stop_details"] !== undefined) stopDetails = d["stop_details"];
          const u = event["usage"] as UsageLike | undefined;
          if (u !== undefined) usage = { ...usage, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== null && v !== undefined)) };
        } else if (type === "error") {
          const err = event["error"] as { message?: string; type?: string } | undefined;
          throw new ProviderError(`Anthropic stream error for model '${req.role.modelId}': ${err?.message ?? err?.type ?? "unknown"}`, "See the provider message; the turn ended.", { provider: "anthropic", model: req.role.modelId, retryable: false });
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal?.aborted === true) cancelled = true;
      else throw toProviderError(error, "anthropic", req.role.modelId);
    }
    for (const acc of blocks.values()) {
      const delta = finishBlock(acc);
      if (delta !== undefined && !cancelled) yield delta;
    }
    (req.debug ?? this.debug)?.response(req.role.name, { stop_reason: stopRaw, usage, thinking_blocks: thinkingPayloads.length, tool_calls: toolCalls });
    if (cancelled) {
      yield { kind: "usage", usage: normalizeUsage(usage), stopReason: "cancelled", thinkingPayloads };
      return;
    }
    const { stop, notice } = mapStopReason(stopRaw, stopDetails);
    for (const n of laterNotices) yield { kind: "notice", text: n };
    if (notice !== undefined) yield { kind: "notice", text: notice };
    yield { kind: "usage", usage: normalizeUsage(usage), stopReason: stop, thinkingPayloads };
  }

  supportsWebSearch(): boolean {
    return true;
  }

  async webSearch(query: string, role: ResolvedRole, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const client = await this.clientOrCreate();
    let response: { content?: Array<Record<string, unknown>> };
    try {
      response = (await client.messages.create(
        { model: role.modelId, max_tokens: Math.min(role.maxOutput, 2048), messages: [{ role: "user", content: `Search the web for: ${query}` }], tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: 1, allowed_callers: ["direct"] }] },
        signal !== undefined ? { signal } : undefined,
      )) as { content?: Array<Record<string, unknown>> };
    } catch (error) {
      throw toProviderError(error, "anthropic", role.modelId);
    }
    const results: WebSearchResult[] = [];
    const textParts: string[] = [];
    for (const block of response.content ?? []) {
      if (block["type"] === "web_search_tool_result") {
        for (const entry of (block["content"] as Array<Record<string, unknown>> | undefined) ?? []) {
          if (entry["type"] === "web_search_result") results.push({ title: String(entry["title"] ?? ""), url: String(entry["url"] ?? ""), snippet: String(entry["page_age"] ?? "") });
        }
      } else if (block["type"] === "text") textParts.push(String(block["text"] ?? ""));
    }
    const summary = textParts.join(" ").slice(0, 300);
    for (const r of results) if (r.snippet.length === 0) r.snippet = summary;
    if (results.length === 0 && summary.length > 0) results.push({ title: "Web search response", url: "", snippet: summary });
    return results;
  }
}
