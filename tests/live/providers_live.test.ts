// Key-gated live round trips (HERAV1PRVD-TP01 TC-24..27, 29, 30). Skipped without the provider key.
// Models: the configured defaults (gpt-4.1-mini, glm-5.2) plus the cheapest enabled Anthropic model from the registry.

import { describe, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_FILE_NAME, parseKeyFile, resolveKey, type KeyedProvider } from "../../src/config/keys.ts";
import { loadConfig, resolveRole, type ModelRegistry, type ParameterMapping, type ResolvedRole } from "../../src/config/load.ts";
import type { ToolDefinition } from "../../src/models.ts";
import type { AdapterDelta, ProviderAdapter } from "../../src/providers/base.ts";
import { DebugDumper } from "../../src/providers/debugdump.ts";
import { getAdapter, resetAdapterCache } from "../../src/providers/registry.ts";
import { assertNoSecretLeak } from "../harness/assertions.ts";
import { liveTest, recordSpend } from "../harness/live.ts";
import { REPO_ROOT, makeTempDir, removeDir } from "../harness/procs.ts";

const CONFIG_DIR = join(REPO_ROOT, ".agent-data", "config");
const registry = JSON.parse(readFileSync(join(CONFIG_DIR, "model-registry.json"), "utf8")) as ModelRegistry;
const mapping = JSON.parse(readFileSync(join(CONFIG_DIR, "model-parameter-mapping.json"), "utf8")) as ParameterMapping;
const pricing = (JSON.parse(readFileSync(join(CONFIG_DIR, "model-pricing.json"), "utf8")) as { pricing: Record<string, Record<string, { input_per_1m: number; cached_per_1m?: number; cache_write_per_1m?: number; output_per_1m: number }>> }).pricing;

function cheapestEnabled(provider: KeyedProvider): string {
  const candidates = registry.models.filter((m) => m.provider === provider && m.enabled);
  candidates.sort((a, b) => (pricing[provider]?.[a.model_id]?.output_per_1m ?? 1e9) - (pricing[provider]?.[b.model_id]?.output_per_1m ?? 1e9));
  return candidates[0]?.model_id ?? "";
}

const MODELS: Record<KeyedProvider, string> = { openai: "gpt-4.1-mini", anthropic: cheapestEnabled("anthropic"), zai: "glm-5.2" };

function liveRole(provider: KeyedProvider, name: ResolvedRole["name"] = "generating", effort = "low"): ResolvedRole {
  return resolveRole(name, { model_id: MODELS[provider], effort }, registry, mapping, "live");
}

async function adapterFor(provider: KeyedProvider, debug?: DebugDumper): Promise<ProviderAdapter> {
  resetAdapterCache();
  const keyFile = join(CONFIG_DIR, KEY_FILE_NAME);
  let entries: Record<string, string> = {};
  try {
    entries = parseKeyFile(readFileSync(keyFile, "utf8")).entries;
  } catch {
    /* env only */
  }
  const handle = resolveKey(provider, process.env, entries);
  if (handle === undefined) throw new Error(`no key for ${provider}`);
  return getAdapter(provider, { keys: { [provider]: handle }, env: {}, debug });
}

function spend(provider: KeyedProvider, model: string, usage: { uncachedInput: number; cacheWrite: number; cacheRead: number; output: number }): void {
  const price = pricing[provider]?.[model];
  if (price === undefined) return;
  const cacheReadRate = price.cached_per_1m ?? price.input_per_1m;
  const cacheWriteRate = price.cache_write_per_1m ?? price.input_per_1m * 1.25;
  recordSpend((usage.uncachedInput * price.input_per_1m + usage.cacheWrite * cacheWriteRate + usage.cacheRead * cacheReadRate + usage.output * price.output_per_1m) / 1e6);
}

async function run(adapter: ProviderAdapter, role: ResolvedRole, prompt: string, tools: ToolDefinition[] = []): Promise<AdapterDelta[]> {
  const out: AdapterDelta[] = [];
  for await (const d of adapter.streamTurn({ system: "You are a terse assistant used in an automated test. Answer in one short sentence.", tools, messages: [{ role: "user", content: prompt }], role })) out.push(d);
  const usage = out[out.length - 1];
  if (usage?.kind === "usage") spend(role.provider as KeyedProvider, role.modelId, usage.usage);
  return out;
}

const READ_TOOL: ToolDefinition = { name: "read_file", description: "Reads a text file and returns its content.", parameters: { type: "object", properties: { file_path: { type: "string", description: "path of the file" } }, required: ["file_path"] } };

describe("[live] HERAV1PRVD-TP01 provider round trips", () => {
  for (const provider of ["openai", "anthropic", "zai"] as KeyedProvider[]) {
    liveTest(`HERAV1PRVD-TP01-TC-24 ${provider} ${MODELS[provider]}: minimal round trip → text + usage, stop end`, provider, async () => {
      const adapter = await adapterFor(provider);
      const out = await run(adapter, liveRole(provider), "Reply with the single word: pong");
      const text = out.filter((d) => d.kind === "text").map((d) => (d as { text: string }).text).join("");
      expect(text.toLowerCase()).toContain("pong");
      const usage = out[out.length - 1];
      expect(usage?.kind).toBe("usage");
      if (usage?.kind === "usage") {
        expect(usage.stopReason).toBe("end");
        expect(usage.usage.uncachedInput + usage.usage.cacheRead + usage.usage.cacheWrite).toBeGreaterThan(0);
        expect(usage.usage.output).toBeGreaterThan(0);
      }
    });
  }

  liveTest("HERAV1PRVD-TP01-TC-25 OpenAI gpt-4.1-mini tool call → stop tool_calls, arguments valid JSON", "openai", async () => {
    const adapter = await adapterFor("openai");
    const out = await run(adapter, liveRole("openai"), "Use the read_file tool to read the file named NOTES.md. Do not answer without calling the tool.", [READ_TOOL]);
    const call = out.find((d) => d.kind === "tool_call");
    expect(call).toBeDefined();
    if (call?.kind === "tool_call") {
      expect(call.toolCall.name).toBe("read_file");
      expect(JSON.parse(call.toolCall.argsJson)).toMatchObject({ file_path: expect.stringContaining("NOTES.md") });
    }
    const usage = out[out.length - 1];
    expect(usage?.kind === "usage" && usage.stopReason).toBe("tool_calls");
  });

  liveTest("HERAV1PRVD-TP01-TC-26 Anthropic: two identical calls → the second reports cache_read_tokens > 0", "anthropic", async () => {
    const adapter = await adapterFor("anthropic");
    const role = liveRole("anthropic");
    // Haiku-class models cache prefixes of 2048+ tokens; 400 lines keep the prefix well above that minimum
    const filler = Array.from({ length: 400 }, (_, i) => `Rule ${i + 1}: keep answers short and factual; this line pads the prompt so the cacheable prefix exceeds the minimum size.`).join("\n");
    const request = { system: `You are a terse assistant.\n${filler}`, tools: [READ_TOOL], messages: [{ role: "user" as const, content: "Reply with the single word: pong" }], role };
    const usages: Array<{ cacheRead: number; cacheWrite: number }> = [];
    for (let i = 0; i < 2; i++) {
      let last: AdapterDelta | undefined;
      for await (const d of adapter.streamTurn(request)) last = d;
      if (last?.kind === "usage") {
        usages.push(last.usage);
        spend("anthropic", role.modelId, last.usage);
      }
    }
    expect(usages).toHaveLength(2);
    expect((usages[0]?.cacheWrite ?? 0) + (usages[0]?.cacheRead ?? 0)).toBeGreaterThan(0);
    expect(usages[1]?.cacheRead ?? 0).toBeGreaterThan(0);
  }, 90000);

  liveTest("HERAV1PRVD-TP01-TC-27 Z.ai glm-5.2 with reasoning_effort via the request body → reasoning_content streamed", "zai", async () => {
    const adapter = await adapterFor("zai");
    const out = await run(adapter, liveRole("zai", "generating", "high"), "What is 17 multiplied by 23? Think step by step, then answer with the number only.");
    expect(out.some((d) => d.kind === "thinking")).toBe(true);
    const text = out.filter((d) => d.kind === "text").map((d) => (d as { text: string }).text).join("");
    expect(text).toContain("391");
    const usage = out[out.length - 1];
    expect(usage?.kind === "usage" && usage.thinkingPayloads[0]?.provider).toBe("zai");
  }, 90000);

  for (const provider of ["openai", "anthropic", "zai"] as KeyedProvider[]) {
    liveTest(`HERAV1PRVD-TP01-TC-29 ${provider} webSearch returns at least one result with a URL`, provider, async () => {
      const adapter = await adapterFor(provider);
      expect(adapter.supportsWebSearch()).toBe(true);
      const results = await adapter.webSearch("Bun JavaScript runtime official website", liveRole(provider, "websearch"));
      recordSpend(0.02);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.url.startsWith("http"))).toBe(true);
    }, 90000);
  }

  liveTest("HERAV1PRVD-TP01-TC-30 --debug dump of a live call contains no key value", "openai", async () => {
    const dir = makeTempDir("livedump");
    try {
      const dumper = new DebugDumper(join(dir, "debug"), "exec");
      const adapter = await adapterFor("openai", dumper);
      await run(adapter, liveRole("openai"), "Reply with the single word: pong");
      const files = readdirSync(join(dir, "debug"));
      expect(files.length).toBeGreaterThanOrEqual(2);
      const texts = files.map((f) => readFileSync(join(dir, "debug", f), "utf8"));
      const keyFile = join(CONFIG_DIR, KEY_FILE_NAME);
      const decoys: string[] = [];
      try {
        decoys.push(...Object.values(parseKeyFile(readFileSync(keyFile, "utf8")).entries));
      } catch {
        /* env only */
      }
      for (const v of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ZAI_API_KEY"]) if (process.env[v]) decoys.push(process.env[v] as string);
      assertNoSecretLeak(texts, undefined, decoys);
    } finally {
      removeDir(dir);
    }
  });

  liveTest("config loads the real key file for the requested role set only", "anthropic", async () => {
    const resolved = loadConfig({ appDir: REPO_ROOT, roles: ["generating"], requireKeys: true, scripted: false });
    expect(Object.keys(resolved.keys)).toEqual(["anthropic"]);
    await Promise.resolve();
  });
});
