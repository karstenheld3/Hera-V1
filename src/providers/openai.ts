// OpenAI adapter over the Responses API (HERAV1PRVD-SP01 FR-02; HERAV1PRVD-IP01 IS-03). Port of V1 openai_adapter.py.
// The output array is parsed typed (message | reasoning | function_call); reasoning items are resent verbatim.

import type { KeyHandle } from "../config/keys.ts";
import type { ResolvedRole } from "../config/load.ts";
import { ProviderError } from "../errors.ts";
import type { Message, ProviderId, StopReason, ThinkingBlock, ToolCall, Usage } from "../models.ts";
import { toResponsesTool, type AdapterDelta, type ProviderAdapter, type TurnRequest, type WebSearchResult } from "./base.ts";
import type { DebugDumper } from "./debugdump.ts";
import { toProviderError, withRetries } from "./retry.ts";

export const OPENAI_TIMEOUT_MS = 120_000;

type Params = Record<string, unknown>;

/** The slice of the openai SDK client the adapter uses; tests inject a replaying fake. */
export interface OpenAIClientLike {
  responses: { create(params: Params, options?: Params): Promise<unknown> };
}

export type OpenAIClientFactory = (key: KeyHandle) => Promise<OpenAIClientLike>;

const defaultFactory: OpenAIClientFactory = async (key) => {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey: key.reveal(), timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 }) as unknown as OpenAIClientLike;
};

/** Canonical messages → Responses `input` items; the system prompt travels as `instructions`. */
export function buildInputItems(messages: Message[]): Params[] {
  const items: Params[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") items.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      for (const t of m.thinking ?? []) if (t.provider === "openai") items.push(t.payload as Params);
      if (m.content.length > 0) items.push({ role: "assistant", content: m.content });
      for (const c of m.toolCalls ?? []) items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.argsJson });
    } else if (m.role === "tool") items.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
  }
  return items;
}

export function buildRequestParams(role: ResolvedRole): Params {
  const params: Params = { max_output_tokens: role.maxOutput };
  if (role.params.method === "temperature") params["temperature"] = role.params.temperature;
  else if (role.params.method === "reasoning_effort") {
    params["reasoning"] = { effort: role.params.reasoning_effort };
    params["include"] = ["reasoning.encrypted_content"];
  }
  return params;
}

export function buildResponsesRequest(req: TurnRequest): Params {
  const request: Params = { model: req.role.modelId, instructions: req.system, input: buildInputItems(req.messages), store: false, stream: true, ...buildRequestParams(req.role) };
  if (req.tools.length > 0) request["tools"] = req.tools.map(toResponsesTool);
  return request;
}

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

export function normalizeUsage(usage: UsageLike | undefined): Usage {
  const input = usage?.input_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  return { uncachedInput: Math.max(0, input - cached), cacheWrite: 0, cacheRead: cached, output: usage?.output_tokens ?? 0 };
}

interface ResponseLike {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<Record<string, unknown>>;
  usage?: UsageLike;
  error?: { message?: string } | null;
  output_text?: string;
}

export function stopReasonOf(response: ResponseLike, toolCalls: number): { stop: StopReason; notice?: string } {
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason ?? "unknown";
    if (reason === "content_filter") return { stop: "refusal", notice: "OpenAI ended the response: content_filter" };
    return { stop: "max_output", notice: reason === "max_output_tokens" ? undefined : `OpenAI ended the response incomplete: ${reason}` };
  }
  return { stop: toolCalls > 0 ? "tool_calls" : "end" };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider: ProviderId = "openai";
  private client: OpenAIClientLike | undefined;

  constructor(
    private readonly key: KeyHandle,
    private readonly debug: DebugDumper | undefined = undefined,
    private readonly factory: OpenAIClientFactory = defaultFactory,
  ) {}

  private async clientOrCreate(): Promise<OpenAIClientLike> {
    if (this.client === undefined) this.client = await this.factory(this.key);
    return this.client;
  }

  async *streamTurn(req: TurnRequest, signal?: AbortSignal): AsyncIterable<AdapterDelta> {
    const request = buildResponsesRequest(req);
    (req.debug ?? this.debug)?.request(req.role.name, request);
    const notices: string[] = [];
    const stream = await withRetries(
      async () => {
        const client = await this.clientOrCreate();
        return (await client.responses.create(request, signal !== undefined ? { signal } : undefined)) as AsyncIterable<Record<string, unknown>>;
      },
      { provider: "openai", model: req.role.modelId, onNotice: (t) => notices.push(t) },
    );
    for (const n of notices) yield { kind: "notice", text: n };
    let final: ResponseLike | undefined;
    let cancelled = false;
    try {
      for await (const event of stream) {
        if (signal?.aborted === true) {
          cancelled = true;
          break;
        }
        const type = event["type"] as string | undefined;
        if (type === "response.output_text.delta") yield { kind: "text", text: String(event["delta"] ?? "") };
        else if (type === "response.reasoning_summary_text.delta") yield { kind: "thinking", text: String(event["delta"] ?? "") };
        else if (type === "response.completed" || type === "response.incomplete") final = event["response"] as ResponseLike;
        else if (type === "response.failed") {
          const detail = (event["response"] as ResponseLike | undefined)?.error?.message ?? "response.failed";
          throw new ProviderError(`OpenAI response failed for model '${req.role.modelId}': ${detail}`, "See the provider message; the turn ended.", { provider: "openai", model: req.role.modelId, retryable: false });
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal?.aborted === true) cancelled = true;
      else throw toProviderError(error, "openai", req.role.modelId);
    }
    const thinkingPayloads: ThinkingBlock[] = [];
    if (cancelled) {
      yield { kind: "usage", usage: normalizeUsage(final?.usage), stopReason: "cancelled", thinkingPayloads };
      return;
    }
    if (final === undefined) throw new ProviderError(`OpenAI stream for model '${req.role.modelId}' ended without response.completed.`, "Retry the turn.", { provider: "openai", model: req.role.modelId, retryable: false });
    (req.debug ?? this.debug)?.response(req.role.name, final);
    let toolCalls = 0;
    for (const item of final.output ?? []) {
      const itemType = item["type"];
      if (itemType === "reasoning") {
        const payload: Params = {};
        for (const k of ["id", "type", "summary", "encrypted_content"]) if (k in item) payload[k] = item[k];
        thinkingPayloads.push({ provider: "openai", payload });
      } else if (itemType === "function_call") {
        toolCalls++;
        const id = (item["call_id"] as string | undefined) ?? (item["id"] as string | undefined) ?? `call_${crypto.randomUUID().slice(0, 8)}`;
        const argsJson = typeof item["arguments"] === "string" && item["arguments"].length > 0 ? item["arguments"] : "{}";
        const call: ToolCall = { id, name: String(item["name"]), argsJson, status: "pending" };
        try {
          call.args = JSON.parse(argsJson) as Record<string, unknown>;
        } catch {
          /* raw args_json kept; the tool layer reports the parse failure (EC) */
        }
        yield { kind: "tool_call", toolCall: call };
      }
    }
    const { stop, notice } = stopReasonOf(final, toolCalls);
    if (notice !== undefined) yield { kind: "notice", text: notice };
    yield { kind: "usage", usage: normalizeUsage(final.usage), stopReason: stop, thinkingPayloads };
  }

  supportsWebSearch(): boolean {
    return true;
  }

  async webSearch(query: string, role: ResolvedRole, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const client = await this.clientOrCreate();
    let response: ResponseLike;
    try {
      response = (await client.responses.create({ model: role.modelId, input: `Search the web for: ${query}`, tools: [{ type: "web_search" }], store: false }, signal !== undefined ? { signal } : undefined)) as ResponseLike;
    } catch (error) {
      throw toProviderError(error, "openai", role.modelId);
    }
    const text = (response.output_text ?? "").slice(0, 300);
    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    for (const item of response.output ?? []) {
      if (item["type"] !== "message") continue;
      for (const content of (item["content"] as Array<Record<string, unknown>> | undefined) ?? []) {
        for (const ann of (content["annotations"] as Array<Record<string, unknown>> | undefined) ?? []) {
          const url = ann["url"];
          if (ann["type"] === "url_citation" && typeof url === "string" && !seen.has(url)) {
            seen.add(url);
            results.push({ title: (ann["title"] as string | undefined) ?? url, url, snippet: text });
          }
        }
      }
    }
    if (results.length === 0 && text.length > 0) results.push({ title: "Web search response", url: "", snippet: text });
    return results;
  }
}
