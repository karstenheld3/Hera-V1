import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyHandle } from "../../src/config/keys.ts";
import type { EffortParams, ResolvedRole } from "../../src/config/load.ts";
import { ProviderError } from "../../src/errors.ts";
import type { Message, ToolDefinition } from "../../src/models.ts";
import { AnthropicAdapter, buildMessages as buildAnthropicMessages, buildMessagesRequest, mapStopReason } from "../../src/providers/anthropic.ts";
import type { AdapterDelta, ProviderAdapter } from "../../src/providers/base.ts";
import { OpenAIAdapter, buildInputItems, buildResponsesRequest } from "../../src/providers/openai.ts";
import { ScriptedAdapter } from "../../src/providers/scripted.ts";
import { configureRetrySleep } from "../../src/providers/retry.ts";
import { ZaiAdapter, buildChatRequest, mapFinishReason, zaiExtraBody } from "../../src/providers/zai.ts";
import { fakeSdk, loadEvents, sdkError } from "../harness/fake_sdk.ts";
import { REPO_ROOT } from "../harness/procs.ts";

beforeAll(() => configureRetrySleep(() => Promise.resolve()));
afterAll(() => configureRetrySleep(undefined));

const KEY = (p: "openai" | "anthropic" | "zai"): KeyHandle => new KeyHandle(p, "env", `HERA_DECOY_${p}_key_value_0000000000`);

const role = (provider: ResolvedRole["provider"], modelId: string, params: EffortParams, maxOutput = 8192): ResolvedRole => ({ name: "generating", modelId, provider, method: params.method, effort: "high", params, maxInput: 200000, maxOutput, contextWindow: 200000 });

const TOOL: ToolDefinition = { name: "read_file", description: "Reads a file.", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } };
const LIST: ToolDefinition = { name: "list_dir", description: "Lists.", parameters: { type: "object", properties: {} } };

async function collect(adapter: ProviderAdapter, r: ResolvedRole, messages: Message[] = [{ role: "user", content: "hi" }], signal?: AbortSignal): Promise<AdapterDelta[]> {
  const out: AdapterDelta[] = [];
  for await (const d of adapter.streamTurn({ system: "sys", tools: [TOOL, LIST], messages, role: r }, signal)) out.push(d);
  return out;
}

const kinds = (deltas: AdapterDelta[]): string[] => deltas.map((d) => d.kind);
const usageOf = (deltas: AdapterDelta[]): Extract<AdapterDelta, { kind: "usage" }> => {
  const last = deltas[deltas.length - 1];
  if (last?.kind !== "usage") throw new Error(`last delta is ${last?.kind}`);
  return last;
};

const openaiRole = role("openai", "gpt-5.6-sol", { method: "reasoning_effort", reasoning_effort: "high" }, 32768);
const anthropicRole = role("anthropic", "claude-sonnet-4-5-20250929", { method: "thinking", thinking_budget: 10000 }, 16384);
const zaiRole = role("zai", "glm-5.2", { method: "reasoning_effort", reasoning_effort: "high" }, 16384);

describe("HERAV1PRVD-TP01 OpenAI adapter (fixtures)", () => {
  test("HERAV1PRVD-TP01-TC-05 reasoning + two calls: order, encrypted payload, cached tokens", async () => {
    const sdk = fakeSdk({ responses: [loadEvents("openai_reasoning_two_calls")] });
    const adapter = new OpenAIAdapter(KEY("openai"), undefined, () => Promise.resolve(sdk.openai));
    const out = await collect(adapter, openaiRole);
    expect(kinds(out)).toEqual(["thinking", "text", "text", "tool_call", "tool_call", "usage"]);
    expect(out[3]?.kind === "tool_call" && out[3].toolCall).toMatchObject({ id: "call_a1", name: "read_file", args: { file_path: "a.md" }, status: "pending" });
    expect(out[4]?.kind === "tool_call" && out[4].toolCall.id).toBe("call_b2");
    const usage = usageOf(out);
    expect(usage.stopReason).toBe("tool_calls");
    expect(usage.usage).toEqual({ uncachedInput: 176, cacheWrite: 0, cacheRead: 1024, output: 80 });
    expect(usage.thinkingPayloads).toEqual([{ provider: "openai", payload: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Need two files." }], encrypted_content: "ENC_PAYLOAD_1" } }]);
  });

  test("HERAV1PRVD-TP01-TC-06 request shape per method", () => {
    const req = buildResponsesRequest({ system: "S", tools: [TOOL], messages: [{ role: "user", content: "q" }], role: openaiRole });
    expect(req).toMatchObject({ model: "gpt-5.6-sol", instructions: "S", store: false, stream: true, reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"], max_output_tokens: 32768 });
    expect(req["tools"]).toEqual([{ type: "function", name: "read_file", description: "Reads a file.", parameters: TOOL.parameters }]);
    expect(req["input"]).toEqual([{ role: "user", content: "q" }]);
    const temp = buildResponsesRequest({ system: "S", tools: [], messages: [], role: role("openai", "gpt-4.1-mini", { method: "temperature", temperature: 0.7 }) });
    expect(temp["temperature"]).toBe(0.7);
    expect("reasoning" in temp).toBe(false);
    expect("tools" in temp).toBe(false);
  });

  test("HERAV1PRVD-TP01-TC-07 malformed arguments keep args_json raw without throwing; incomplete → max_output", async () => {
    const sdk = fakeSdk({ responses: [loadEvents("openai_bad_args"), loadEvents("openai_incomplete")] });
    const adapter = new OpenAIAdapter(KEY("openai"), undefined, () => Promise.resolve(sdk.openai));
    const out = await collect(adapter, openaiRole);
    expect(kinds(out)).toEqual(["tool_call", "usage"]);
    const call = out[0]?.kind === "tool_call" ? out[0].toolCall : undefined;
    expect(call?.argsJson).toBe('{"file_path": "a.md", "old_string": ');
    expect(call?.args).toBeUndefined();
    const incomplete = await collect(adapter, openaiRole);
    expect(kinds(incomplete)).toEqual(["text", "usage"]);
    expect(usageOf(incomplete).stopReason).toBe("max_output");
  });

  test("HERAV1PRVD-TP01-TC-08 openai thinking blocks resent as reasoning items; anthropic blocks dropped", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "Reading.", thinking: [{ provider: "openai", payload: { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "ENC" } }, { provider: "anthropic", payload: { type: "thinking", thinking: "x", signature: "s" } }], toolCalls: [{ id: "call_1", name: "read_file", argsJson: '{"file_path":"a"}', status: "ok" }] },
      { role: "tool", content: "file body", toolCallId: "call_1" },
    ];
    expect(buildInputItems(messages)).toEqual([{ role: "user", content: "q" }, { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "ENC" }, { role: "assistant", content: "Reading." }, { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"file_path":"a"}' }, { type: "function_call_output", call_id: "call_1", output: "file body" }]);
  });

  test("HERAV1PRVD-TP01-TC-02/22 retry notices precede deltas; failure after the first delta is not retried", async () => {
    const sdk = fakeSdk({ responses: [sdkError(503, "overloaded", "InternalServerError"), loadEvents("openai_incomplete")] });
    const adapter = new OpenAIAdapter(KEY("openai"), undefined, () => Promise.resolve(sdk.openai));
    const out = await collect(adapter, openaiRole);
    expect(kinds(out)[0]).toBe("notice");
    expect(out[0]?.kind === "notice" && out[0].text).toBe("OpenAI InternalServerError -> retrying in 2s (attempt 1/2)...");
    expect(sdk.calls).toHaveLength(2);
    const failing = fakeSdk({ responses: [[{ type: "response.output_text.delta", delta: "partial" }, { type: "response.failed", response: { error: { message: "server exploded" } } }]] });
    const adapter2 = new OpenAIAdapter(KEY("openai"), undefined, () => Promise.resolve(failing.openai));
    let err: unknown;
    try {
      await collect(adapter2, openaiRole);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain("server exploded");
    expect(failing.calls).toHaveLength(1);
  });
});

describe("HERAV1PRVD-TP01 Anthropic adapter (fixtures)", () => {
  const make = (...names: string[]): { adapter: AnthropicAdapter; sdk: ReturnType<typeof fakeSdk> } => {
    const sdk = fakeSdk({ responses: names.map(loadEvents) });
    return { adapter: new AnthropicAdapter(KEY("anthropic"), undefined, () => Promise.resolve(sdk.anthropic)), sdk };
  };

  test("HERAV1PRVD-TP01-TC-09 thinking + tool: tool call assembled from input_json_delta, signature captured, stop tool_calls", async () => {
    const { adapter } = make("anthropic_thinking_tool");
    const out = await collect(adapter, anthropicRole);
    expect(kinds(out)).toEqual(["thinking", "thinking", "text", "tool_call", "usage"]);
    expect(out[3]?.kind === "tool_call" && out[3].toolCall).toMatchObject({ id: "toolu_01", name: "read_file", argsJson: '{"file_path": "README.md"}', args: { file_path: "README.md" } });
    const usage = usageOf(out);
    expect(usage.stopReason).toBe("tool_calls");
    expect(usage.thinkingPayloads).toEqual([{ provider: "anthropic", payload: { type: "thinking", thinking: "Let me read the file.", signature: "SIG_ABC" } }]);
    expect(usage.usage).toEqual({ uncachedInput: 25, cacheWrite: 0, cacheRead: 0, output: 60 });
  });

  test("HERAV1PRVD-TP01-TC-10 six stop fixtures map to the canonical reasons", async () => {
    const { adapter } = make("anthropic_refusal", "anthropic_pause_turn", "anthropic_max_tokens", "anthropic_context_exceeded", "anthropic_end_turn", "anthropic_stop_sequence");
    const refusal = await collect(adapter, anthropicRole);
    expect(usageOf(refusal).stopReason).toBe("refusal");
    expect(refusal.some((d) => d.kind === "notice" && d.text.includes('"type":"safety"'))).toBe(true);
    expect(usageOf(await collect(adapter, anthropicRole)).stopReason).toBe("pause");
    const max = await collect(adapter, anthropicRole);
    expect(usageOf(max).stopReason).toBe("max_output");
    expect(max.some((d) => d.kind === "notice")).toBe(false);
    const ctx = await collect(adapter, anthropicRole);
    expect(usageOf(ctx).stopReason).toBe("max_output");
    expect(ctx.some((d) => d.kind === "notice" && d.text.includes("context window exceeded"))).toBe(true);
    expect(usageOf(await collect(adapter, anthropicRole)).stopReason).toBe("end");
    expect(usageOf(await collect(adapter, anthropicRole)).stopReason).toBe("end");
    expect(mapStopReason(undefined).stop).toBe("end");
  });

  test("HERAV1PRVD-TP01-TC-11 cache usage: uncached_input = input_tokens; cache_write and cache_read separate", async () => {
    const { adapter } = make("anthropic_cache_usage");
    const usage = usageOf(await collect(adapter, anthropicRole));
    expect(usage.usage).toEqual({ uncachedInput: 100, cacheWrite: 2000, cacheRead: 20000, output: 12 });
  });

  test("HERAV1PRVD-TP01-TC-12 redacted thinking resent as received; unsigned block dropped with a notice", async () => {
    const { adapter } = make("anthropic_redacted_thinking");
    const out = await collect(adapter, anthropicRole);
    const usage = usageOf(out);
    expect(usage.thinkingPayloads).toEqual([{ provider: "anthropic", payload: { type: "redacted_thinking", data: "REDACTED_OPAQUE" } }]);
    expect(out.filter((d) => d.kind === "notice").map((d) => (d as { text: string }).text)).toEqual(["Anthropic thinking block arrived without a signature - dropped from the resend set."]);
    const resent = buildAnthropicMessages([{ role: "assistant", content: "Ok.", thinking: usage.thinkingPayloads }]);
    expect(resent[0]?.content[0]).toEqual({ type: "redacted_thinking", data: "REDACTED_OPAQUE" });
  });

  test("HERAV1PRVD-TP01-TC-13 request per method; cache breakpoints; beta header for effort", () => {
    const thinking = buildMessagesRequest({ system: "S", tools: [TOOL, LIST], messages: [{ role: "user", content: "q" }], role: anthropicRole });
    expect(thinking.params).toMatchObject({ model: "claude-sonnet-4-5-20250929", thinking: { type: "enabled", budget_tokens: 10000 }, max_tokens: 16384, tool_choice: { type: "auto" }, stream: true });
    expect(thinking.params["system"]).toEqual([{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
    const tools = thinking.params["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ name: "read_file", description: "Reads a file.", input_schema: TOOL.parameters });
    expect(tools[1]?.["cache_control"]).toEqual({ type: "ephemeral" });
    expect("cache_control" in (tools[0] ?? {})).toBe(false);
    expect(thinking.options).toBeUndefined();
    const adaptive = buildMessagesRequest({ system: "S", tools: [], messages: [], role: role("anthropic", "claude-sonnet-5", { method: "adaptive_thinking", effort: "high" }) });
    expect(adaptive.params["thinking"]).toEqual({ type: "adaptive" });
    expect(adaptive.params["output_config"]).toEqual({ effort: "high" });
    const effort = buildMessagesRequest({ system: "S", tools: [], messages: [], role: role("anthropic", "claude-opus-4.5", { method: "effort", effort: "low", beta: "effort-2025-11-24" }) });
    expect("thinking" in effort.params).toBe(false);
    expect(effort.params["output_config"]).toEqual({ effort: "low" });
    expect(effort.options).toEqual({ headers: { "anthropic-beta": "effort-2025-11-24" } });
    const temp = buildMessagesRequest({ system: "S", tools: [], messages: [], role: role("anthropic", "claude-3-5", { method: "temperature", temperature: 0.35 }) });
    expect(temp.params["temperature"]).toBe(0.35);
    const small = buildMessagesRequest({ system: "S", tools: [], messages: [], role: role("anthropic", "claude-sonnet-4", { method: "thinking", thinking_budget: 400 }) });
    expect("thinking" in small.params).toBe(false);
    // alternation rule: consecutive tool results merge into one user message
    const merged = buildAnthropicMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", argsJson: "{}", status: "ok" }, { id: "t2", name: "list_dir", argsJson: "{}", status: "ok" }] },
      { role: "tool", content: "r1", toolCallId: "t1" },
      { role: "tool", content: "r2", toolCallId: "t2" },
    ]);
    expect(merged.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(merged[2]?.content).toHaveLength(2);
  });
});

describe("HERAV1PRVD-TP01 Z.ai adapter (fixtures)", () => {
  const make = (...names: string[]): { adapter: ZaiAdapter; sdk: ReturnType<typeof fakeSdk> } => {
    const sdk = fakeSdk({ responses: names.map(loadEvents) });
    return { adapter: new ZaiAdapter(KEY("zai"), undefined, () => Promise.resolve(sdk.chat)), sdk };
  };

  test("HERAV1PRVD-TP01-TC-14 interleaved reasoning, text, and indexed tool calls", async () => {
    const { adapter } = make("zai_reasoning_tools_interleaved");
    const out = await collect(adapter, zaiRole);
    expect(kinds(out)).toEqual(["thinking", "thinking", "text", "text", "tool_call", "tool_call", "usage"]);
    expect(out[4]?.kind === "tool_call" && out[4].toolCall).toMatchObject({ id: "call_z1", name: "read_file", argsJson: '{"file_path": "a.md"}', args: { file_path: "a.md" } });
    expect(out[5]?.kind === "tool_call" && out[5].toolCall).toMatchObject({ id: "call_z2", name: "list_dir", args: { path: "." } });
    const usage = usageOf(out);
    expect(usage.stopReason).toBe("tool_calls");
    expect(usage.usage).toEqual({ uncachedInput: 244, cacheWrite: 0, cacheRead: 256, output: 40 });
    expect(usage.thinkingPayloads).toEqual([{ provider: "zai", payload: { reasoning_content: "First think." } }]);
  });

  test("HERAV1PRVD-TP01-TC-15 missing usage chunk → zeros plus notice; length → max_output", async () => {
    const { adapter } = make("zai_no_usage", "zai_length");
    const out = await collect(adapter, zaiRole);
    expect(kinds(out)).toEqual(["text", "notice", "usage"]);
    expect(usageOf(out).usage).toEqual({ uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    expect(usageOf(out).stopReason).toBe("end");
    expect(usageOf(await collect(adapter, zaiRole)).stopReason).toBe("max_output");
    expect(mapFinishReason("content_filter", 0)).toBe("refusal");
    expect(mapFinishReason(null, 2)).toBe("tool_calls");
  });

  test("HERAV1PRVD-TP01-TC-16 request: nested tools, stream_options, tool_choice auto, extra body per method", () => {
    const req = buildChatRequest({ system: "S", tools: [TOOL], messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a", thinking: [{ provider: "zai", payload: { reasoning_content: "r" } }] }], role: zaiRole });
    expect(req).toMatchObject({ model: "glm-5.2", stream: true, stream_options: { include_usage: true }, tool_choice: "auto", max_tokens: 16384, reasoning_effort: "high", thinking: { type: "enabled", clear_thinking: false } });
    expect(req["tools"]).toEqual([{ type: "function", function: { name: "read_file", description: "Reads a file.", parameters: TOOL.parameters } }]);
    expect(req["messages"]).toEqual([{ role: "system", content: "S" }, { role: "user", content: "q" }, { role: "assistant", reasoning_content: "r", content: "a" }]);
    expect(zaiExtraBody(role("zai", "glm-5", { method: "thinking", thinking_budget: 0 }))).toEqual({ thinking: { type: "disabled", clear_thinking: false } });
    expect(zaiExtraBody(role("zai", "glm-4.7", { method: "thinking", thinking_budget: 5000 }))).toEqual({ thinking: { type: "enabled", clear_thinking: false } });
  });

  test("HERAV1PRVD-TP01-TC-17 400 on thinking → ProviderError naming model and message; no glm- special case in zai.ts", async () => {
    const sdk = fakeSdk({ responses: [sdkError(400, "thinking is not supported for glm-4-air", "BadRequestError")] });
    const adapter = new ZaiAdapter(KEY("zai"), undefined, () => Promise.resolve(sdk.chat));
    let err: unknown;
    try {
      await collect(adapter, role("zai", "glm-4-air", { method: "thinking", thinking_budget: 100 }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain("'glm-4-air'");
    expect((err as Error).message).toContain("thinking is not supported");
    expect((err as ProviderError).retryable).toBe(false);
    expect(sdk.calls).toHaveLength(1);
    const source = readFileSync(join(REPO_ROOT, "src", "providers", "zai.ts"), "utf8");
    expect(source).not.toMatch(/glm-/);
  });
});

describe("HERAV1PRVD-TP01 contract across adapters", () => {
  test("HERAV1PRVD-TP01-TC-02 every adapter over every fixture ends with exactly one usage delta with a canonical stopReason", async () => {
    const canonical = new Set(["end", "tool_calls", "max_output", "refusal", "pause", "cancelled"]);
    const runs: Array<Promise<AdapterDelta[]>> = [];
    for (const name of ["openai_reasoning_two_calls", "openai_bad_args", "openai_incomplete"]) {
      const sdk = fakeSdk({ responses: [loadEvents(name)] });
      runs.push(collect(new OpenAIAdapter(KEY("openai"), undefined, () => Promise.resolve(sdk.openai)), openaiRole));
    }
    for (const name of ["anthropic_thinking_tool", "anthropic_refusal", "anthropic_pause_turn", "anthropic_max_tokens", "anthropic_context_exceeded", "anthropic_end_turn", "anthropic_stop_sequence", "anthropic_redacted_thinking", "anthropic_cache_usage"]) {
      const sdk = fakeSdk({ responses: [loadEvents(name)] });
      runs.push(collect(new AnthropicAdapter(KEY("anthropic"), undefined, () => Promise.resolve(sdk.anthropic)), anthropicRole));
    }
    for (const name of ["zai_reasoning_tools_interleaved", "zai_no_usage", "zai_length"]) {
      const sdk = fakeSdk({ responses: [loadEvents(name)] });
      runs.push(collect(new ZaiAdapter(KEY("zai"), undefined, () => Promise.resolve(sdk.chat)), zaiRole));
    }
    runs.push(collect(new ScriptedAdapter(join(REPO_ROOT, "tests", "fixtures", "scripts", "script_slow.jsonl"), {}), role("scripted", "x", { method: "temperature", temperature: 0 })));
    for (const out of await Promise.all(runs)) {
      expect(out.filter((d) => d.kind === "usage")).toHaveLength(1);
      expect(out[out.length - 1]?.kind).toBe("usage");
      expect(canonical.has(usageOf(out).stopReason)).toBe(true);
    }
  });

  test("HERAV1PRVD-TP01-TC-04 (live adapters) abort mid-stream ends with usage cancelled", async () => {
    const sdk = fakeSdk({ responses: [loadEvents("anthropic_thinking_tool")], delayMs: 20 });
    const adapter = new AnthropicAdapter(KEY("anthropic"), undefined, () => Promise.resolve(sdk.anthropic));
    const controller = new AbortController();
    const out: AdapterDelta[] = [];
    for await (const d of adapter.streamTurn({ system: "s", tools: [], messages: [], role: anthropicRole }, controller.signal)) {
      out.push(d);
      if (out.length === 2) controller.abort();
    }
    expect(kinds(out)).toEqual(["thinking", "thinking", "usage"]);
    expect(usageOf(out).stopReason).toBe("cancelled");
  });

  test("HERAV1PRVD-TP01-TC-32 unknown status (418) is not retried - fails immediately", async () => {
    const sdk = fakeSdk({ responses: [sdkError(418, "I'm a teapot", "UnknownError")] });
    const adapter = new OpenAIAdapter(KEY("openai"), undefined, () => Promise.resolve(sdk.openai));
    let err: unknown;
    try {
      await collect(adapter, openaiRole);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect(sdk.calls).toHaveLength(1);
  });
});
