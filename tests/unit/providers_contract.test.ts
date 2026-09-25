import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyHandle } from "../../src/config/keys.ts";
import type { ModelPrice, ResolvedRole } from "../../src/config/load.ts";
import { computeCost } from "../../src/cost.ts";
import { ProviderError } from "../../src/errors.ts";
import type { ToolDefinition, Usage } from "../../src/models.ts";
import { providerDisplayName, toChatTool, toMessagesTool, toResponsesTool, type AdapterDelta, type ProviderAdapter } from "../../src/providers/base.ts";
import { DebugDumper, redact } from "../../src/providers/debugdump.ts";
import { getAdapter, isScripted, resetAdapterCache } from "../../src/providers/registry.ts";
import { RETRY_MAX, classifyStatus, isRetryableError, redactKeyShapes, retryAfterMs, toProviderError, withRetries } from "../../src/providers/retry.ts";
import { ScriptedAdapter } from "../../src/providers/scripted.ts";
import { normalizeUsage as normalizeUsageOpenAI } from "../../src/providers/openai.ts";
import { normalizeUsage as normalizeUsageAnthropic } from "../../src/providers/anthropic.ts";
import { normalizeUsage as normalizeUsageZai } from "../../src/providers/zai.ts";
import { assertNoSecretLeak } from "../harness/assertions.ts";
import { REPO_ROOT, makeTempDir, removeDir } from "../harness/procs.ts";

const SCRIPTS = join(REPO_ROOT, "tests", "fixtures", "scripts");
const dirs: string[] = [];
afterEach(() => {
  resetAdapterCache();
  for (const d of dirs.splice(0)) removeDir(d);
});

const role = (name: ResolvedRole["name"], provider: ResolvedRole["provider"] = "zai"): ResolvedRole => ({
  name,
  modelId: "glm-5.2",
  provider,
  method: "reasoning_effort",
  effort: "high",
  params: { method: "reasoning_effort", reasoning_effort: "high" },
  maxInput: 1000000,
  maxOutput: 16384,
  contextWindow: 1000000,
});

const TOOL: ToolDefinition = { name: "read_file", description: "Reads a file.", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } };

async function collect(adapter: ProviderAdapter, r: ResolvedRole, signal?: AbortSignal): Promise<AdapterDelta[]> {
  const out: AdapterDelta[] = [];
  for await (const d of adapter.streamTurn({ system: "sys", tools: [TOOL], messages: [{ role: "user", content: "hi" }], role: r }, signal)) out.push(d);
  return out;
}

describe("HERAV1PRVD-TP01 contract", () => {
  test("HERAV1PRVD-TP01-TC-01 the three tool shapes match spec section 3", () => {
    expect(toResponsesTool(TOOL)).toEqual({ type: "function", name: "read_file", description: "Reads a file.", parameters: TOOL.parameters });
    expect(toMessagesTool(TOOL)).toEqual({ name: "read_file", description: "Reads a file.", input_schema: TOOL.parameters });
    expect(toChatTool(TOOL)).toEqual({ type: "function", function: { name: "read_file", description: "Reads a file.", parameters: TOOL.parameters } });
    expect(providerDisplayName("zai")).toBe("Z.ai");
  });

  test("HERAV1PRVD-TP01-TC-03 getAdapter caches per provider; scripted override when the env var is set", async () => {
    const env = { HERA_SCRIPTED_ADAPTER: join(SCRIPTS, "script_roles.jsonl") };
    expect(isScripted(env)).toBe(true);
    expect(isScripted({})).toBe(false);
    const a = await getAdapter("openai", { keys: {}, env });
    const b = await getAdapter("anthropic", { keys: {}, env });
    expect(a).toBe(b);
    expect(a.provider).toBe("scripted");
    resetAdapterCache();
    const made: string[] = [];
    const fake = (p: "openai" | "zai"): ProviderAdapter => ({
      provider: p,
      streamTurn: async function* () {
        yield { kind: "usage", usage: { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, stopReason: "end", thinkingPayloads: [] } as AdapterDelta;
      },
      supportsWebSearch: () => false,
      webSearch: () => Promise.resolve([]),
    });
    const keys = { openai: new KeyHandle("openai", "env", "HERA_DECOY_open"), zai: new KeyHandle("zai", "env", "HERA_DECOY_zai") };
    const factories = {
      openai: () => {
        made.push("openai");
        return fake("openai");
      },
      zai: () => {
        made.push("zai");
        return fake("zai");
      },
    };
    const o1 = await getAdapter("openai", { keys, env: {}, factories });
    const o2 = await getAdapter("openai", { keys, env: {}, factories });
    const z = await getAdapter("zai", { keys, env: {}, factories });
    expect(o1).toBe(o2);
    expect(z).not.toBe(o1);
    expect(made).toEqual(["openai", "zai"]);
    await expect(getAdapter("anthropic", { keys, env: {}, factories })).rejects.toBeInstanceOf(ProviderError);
    await expect(getAdapter("scripted", { keys, env: {} })).rejects.toThrow(/HERA_SCRIPTED_ADAPTER/);
  });

  test("HERAV1PRVD-TP01-TC-04 abort after two deltas on script_slow.jsonl → usage cancelled, no further deltas", async () => {
    const adapter = new ScriptedAdapter(join(SCRIPTS, "script_slow.jsonl"), {});
    const controller = new AbortController();
    const out: AdapterDelta[] = [];
    for await (const d of adapter.streamTurn({ system: "s", tools: [], messages: [], role: role("generating") }, controller.signal)) {
      out.push(d);
      if (out.length === 2) controller.abort();
    }
    expect(out.map((d) => d.kind)).toEqual(["thinking", "text", "usage"]);
    const last = out[2];
    expect(last?.kind === "usage" && last.stopReason).toBe("cancelled");
  });
});

describe("HERAV1PRVD-TP01 scripted", () => {
  test("HERAV1PRVD-TP01-TC-18 per-role cursors; unlabeled lines belong to generating", async () => {
    const adapter = new ScriptedAdapter(join(SCRIPTS, "script_roles.jsonl"), {});
    expect(adapter.remaining("generating")).toBe(3);
    expect(adapter.remaining("supervisor")).toBe(1);
    const sup = await collect(adapter, role("supervisor"));
    expect(sup.map((d) => d.kind)).toEqual(["text", "usage"]);
    const first = await collect(adapter, role("generating"));
    expect(first.map((d) => d.kind)).toEqual(["thinking", "text", "tool_call", "usage"]);
    const call = first[2];
    expect(call?.kind === "tool_call" && call.toolCall).toMatchObject({ id: "tc_0001", name: "read_file", argsJson: '{"file_path":"README.md"}', status: "pending" });
    const usage = first[3];
    expect(usage?.kind === "usage" && usage.stopReason).toBe("tool_calls");
    expect(usage?.kind === "usage" && usage.usage).toEqual({ uncachedInput: 100, cacheWrite: 0, cacheRead: 0, output: 20 });
    expect(usage?.kind === "usage" && usage.thinkingPayloads).toEqual([{ provider: "scripted", payload: { thinking: "plan" } }]);
    const second = await collect(adapter, role("generating"));
    expect(second.map((d) => d.kind)).toEqual(["text", "notice", "usage"]);
    expect(second[1]).toEqual({ kind: "notice", text: "scripted notice" });
    expect(second[2]?.kind === "usage" && second[2].usage.cacheRead).toBe(90);
    expect(second[2]?.kind === "usage" && second[2].stopReason).toBe("end");
    const compacting = await collect(adapter, role("compacting"));
    expect(compacting[1]?.kind === "usage" && compacting[1].stopReason).toBe("end");
  });

  test("HERAV1PRVD-TP01-TC-19 exhausted role and {error} lines raise non-retryable ProviderError", async () => {
    const adapter = new ScriptedAdapter(join(SCRIPTS, "script_roles.jsonl"), {});
    await collect(adapter, role("supervisor"));
    let err: unknown;
    try {
      await collect(adapter, role("supervisor"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain("script_roles.jsonl");
    expect((err as Error).message).toContain("'supervisor'");
    expect((err as ProviderError).retryable).toBe(false);
    await collect(adapter, role("generating"));
    await collect(adapter, role("generating"));
    let simulated: unknown;
    try {
      await collect(adapter, role("generating"));
    } catch (e) {
      simulated = e;
    }
    expect(simulated).toBeInstanceOf(ProviderError);
    expect((simulated as Error).message).toContain("simulated outage");
    expect(isRetryableError(simulated)).toBe(false);
    expect(() => new ScriptedAdapter(join(SCRIPTS, "missing.jsonl"), {})).toThrow(ProviderError);
  });

  test("HERAV1PRVD-TP01-TC-20 capture file has one line per call with role, system, tools; unwritable → warning only", async () => {
    const dir = makeTempDir("capture");
    dirs.push(dir);
    const capture = join(dir, "capture.jsonl");
    const adapter = new ScriptedAdapter(join(SCRIPTS, "script_roles.jsonl"), { HERA_SCRIPTED_CAPTURE: capture });
    await collect(adapter, role("generating"));
    await collect(adapter, role("supervisor"));
    const lines = readFileSync(capture, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as { role: string; system: string; tools: unknown[] });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ role: "generating", system: "sys", tools: [TOOL] });
    expect(lines[1]?.role).toBe("supervisor");
    const warnings: string[] = [];
    const blocked = new ScriptedAdapter(join(SCRIPTS, "script_roles.jsonl"), { HERA_SCRIPTED_CAPTURE: join(dir, "no", "such", "dir", "c.jsonl") }, (l) => warnings.push(l));
    await collect(blocked, role("generating"));
    await collect(blocked, role("generating"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^WARNING: HERA_SCRIPTED_CAPTURE/);
  });

  test("HERAV1PRVD-TP01-TC-21 webSearch returns scripted results, then an empty array", async () => {
    const adapter = new ScriptedAdapter(join(SCRIPTS, "script_roles.jsonl"), {});
    expect(adapter.supportsWebSearch()).toBe(true);
    const results = await adapter.webSearch("example", role("generating"));
    expect(results).toEqual([{ title: "Example", url: "https://example.com/", snippet: "An example page." }]);
    expect(await adapter.webSearch("example", role("generating"))).toEqual([]);
  });
});

describe("HERAV1PRVD-TP01 four-category usage", () => {
  test("HERAV1PRVD-TP01-TC-31 Anthropic published example: 1,000 write-only tokens at base rate 1 with multiplier 1.25 → cost 1,250", () => {
    const usage: Usage = { uncachedInput: 0, cacheWrite: 1000, cacheRead: 0, output: 0 };
    const price: ModelPrice = { input_per_1m: 1, cached_per_1m: 0.1, cache_write_per_1m: 1.25, output_per_1m: 5 };
    // 0 * 1 + 1000 * 1.25 + 0 * 0.1 + 0 * 5 = 1250 / 1e6 = 0.00125
    expect(computeCost(usage, price)).toBe(0.00125);
  });

  test("HERAV1PRVD-TP01-TC-32 categories sum to provider totals for all three adapters", () => {
    // OpenAI: cached_tokens inside input_tokens; uncachedInput = input - cached, cacheRead = cached, cacheWrite = 0
    const openai = normalizeUsageOpenAI({ input_tokens: 1500, output_tokens: 300, input_tokens_details: { cached_tokens: 500 } });
    expect(openai.uncachedInput + openai.cacheWrite + openai.cacheRead).toBe(1500);
    expect(openai.output).toBe(300);

    // Anthropic: input_tokens (uncached), cache_creation_input_tokens → cache_write, cache_read_input_tokens → cache_read
    const anthropic = normalizeUsageAnthropic({ input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 300 });
    expect(anthropic.uncachedInput + anthropic.cacheWrite + anthropic.cacheRead).toBe(1800);
    expect(anthropic.output).toBe(200);

    // Z.ai: cached_tokens inside prompt_tokens; uncachedInput = prompt - cached, cacheRead = cached, cacheWrite = 0
    const zai = normalizeUsageZai({ prompt_tokens: 2000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 800 } });
    expect(zai.uncachedInput + zai.cacheWrite + zai.cacheRead).toBe(2000);
    expect(zai.output).toBe(400);
  });
});

describe("HERAV1PRVD-TP01 retry and errors", () => {
  test("HERAV1PRVD-TP01-TC-22 two 503s then success → two notices with delays 2000/8000; Retry-After honored; failure after the budget rethrows", async () => {
    const slept: number[] = [];
    const notices: string[] = [];
    let calls = 0;
    const sdkError = (status: number, headers?: Record<string, string>): Error => Object.assign(new Error("overloaded"), { status, name: "InternalServerError", headers });
    const result = await withRetries(
      () => {
        calls++;
        if (calls <= 2) return Promise.reject(sdkError(503));
        return Promise.resolve("stream");
      },
      { provider: "anthropic", model: "claude-x", onNotice: (t) => notices.push(t), sleep: (ms) => (slept.push(ms), Promise.resolve()) },
    );
    expect(result).toBe("stream");
    expect(slept).toEqual([2000, 8000]);
    expect(notices).toEqual(["Anthropic InternalServerError -> retrying in 2s (attempt 1/2)...", "Anthropic InternalServerError -> retrying in 8s (attempt 2/2)..."]);
    slept.length = 0;
    calls = 0;
    await withRetries(
      () => {
        calls++;
        return calls === 1 ? Promise.reject(sdkError(429, { "retry-after": "5" })) : Promise.resolve(1);
      },
      { provider: "openai", model: "m", onNotice: () => {}, sleep: (ms) => (slept.push(ms), Promise.resolve()) },
    );
    expect(slept).toEqual([5000]);
    expect(retryAfterMs(sdkError(429, { "retry-after": "120" }))).toBe(30000);
    let thrown: unknown;
    try {
      await withRetries(() => Promise.reject(sdkError(503)), { provider: "zai", model: "glm-5.2", onNotice: () => {}, sleep: () => Promise.resolve() });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).retryable).toBe(true);
    expect((thrown as ProviderError).status).toBe(503);
    expect(RETRY_MAX).toBe(2);
    expect(classifyStatus(408)).toBe("retryable");
    expect(classifyStatus(404)).toBe("fatal");
    expect(classifyStatus(undefined)).toBe("unknown");
    expect(isRetryableError(Object.assign(new Error("x"), { name: "APIConnectionError" }))).toBe(true);
  });

  test("HERAV1PRVD-TP01-TC-23 401 → immediate ProviderError naming the key variable; 400 names provider, model, and message; no key value", async () => {
    const decoy = "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789";
    let attempts = 0;
    let err: unknown;
    try {
      await withRetries(
        () => {
          attempts++;
          return Promise.reject(Object.assign(new Error(`Incorrect API key provided: ${decoy}`), { status: 401, name: "AuthenticationError" }));
        },
        { provider: "openai", model: "gpt-4.1-mini", onNotice: () => {}, sleep: () => Promise.resolve() },
      );
    } catch (e) {
      err = e;
    }
    expect(attempts).toBe(1);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain("OpenAI rejected the API key for model 'gpt-4.1-mini' (HTTP 401)");
    expect((err as ProviderError).action).toContain("OPENAI_API_KEY");
    assertNoSecretLeak([(err as Error).message, (err as ProviderError).action], undefined, [decoy]);
    const bad = toProviderError(Object.assign(new Error("thinking is not supported for this model"), { status: 400, name: "BadRequestError" }), "zai", "glm-4.7");
    expect(bad.message).toStartWith("Z.ai BadRequestError (HTTP 400) for model 'glm-4.7': thinking is not supported for this model");
    expect(bad.retryable).toBe(false);
    expect(redactKeyShapes(`key ${decoy} and sk-ant-api03-abcdefghijk`)).toBe("key *** and ***");
  });

  test("HERAV1PRVD-TP01-TC-28 dump redaction of headers and key-shaped strings; unwritable dir → one warning", () => {
    const dir = makeTempDir("dump");
    dirs.push(dir);
    const warnings: string[] = [];
    const dumper = new DebugDumper(join(dir, "debug"), "exec", (l) => warnings.push(l));
    const key = "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789";
    const path = dumper.request("generating", { headers: { Authorization: `Bearer ${key}`, "x-api-key": key, accept: "json" }, body: { model: "m", note: `uses ${key}` }, nested: [{ token: key }] });
    expect(path).toBeDefined();
    const text = readFileSync(path as string, "utf8");
    assertNoSecretLeak([text], undefined, [key]);
    const parsed = JSON.parse(text) as { headers: Record<string, string>; body: { note: string } };
    expect(parsed.headers["Authorization"]).toBe("***");
    expect(parsed.headers["x-api-key"]).toBe("***");
    expect(parsed.headers["accept"]).toBe("json");
    expect(parsed.body.note).toBe("uses ***");
    expect(readdirSync(join(dir, "debug"))[0]).toMatch(/^\d{8}_\d{9}_0001_exec_generating_request\.json$/);
    expect(redact({ Cookie: "a", x: 1 })).toEqual({ Cookie: "***", x: 1 });
    const blockedDir = join(dir, "blocked");
    mkdirSync(blockedDir);
    writeFileSync(join(blockedDir, "file"), "x");
    const blocked = new DebugDumper(join(blockedDir, "file"), "sup", (l) => warnings.push(l));
    expect(blocked.response("supervisor", { a: 1 })).toBeUndefined();
    expect(blocked.response("supervisor", { a: 2 })).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^WARNING: debug dump to /);
    if (existsSync(join(blockedDir, "file"))) chmodSync(join(blockedDir, "file"), 0o644);
  });
});
