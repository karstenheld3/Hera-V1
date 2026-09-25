// Adapter registry (HERAV1PRVD-SP01 FR-01, FR-05; HERAV1PRVD-IP01 IS-07): one instance per provider per process;
// HERA_SCRIPTED_ADAPTER makes every provider resolve to the one ScriptedAdapter. Live adapters are imported lazily so a
// scripted process never constructs an SDK client.

import type { KeyHandle, KeyedProvider } from "../config/keys.ts";
import type { ResolvedRole } from "../config/load.ts";
import { ProviderError } from "../errors.ts";
import { nowTs, type AgentEvent } from "../events.ts";
import type { ProviderId } from "../models.ts";
import type { ProviderAdapter, TurnRequest, AdapterDelta } from "./base.ts";
import type { DebugDumper } from "./debugdump.ts";
import { SCRIPTED_ENV, ScriptedAdapter } from "./scripted.ts";
import type { Gate } from "../harness/gate.ts";
import { EffectDescriptor } from "../harness/descriptor.ts";
import type { EmitFn } from "../harness/sink.ts";

export interface AdapterFactoryOptions {
  keys: Partial<Record<KeyedProvider, KeyHandle>>;
  env?: Record<string, string | undefined>;
  debug?: DebugDumper | undefined;
  /** injected constructors (tests: fake clients) */
  factories?: Partial<Record<KeyedProvider, (key: KeyHandle, debug: DebugDumper | undefined) => ProviderAdapter>>;
}

const cache = new Map<string, ProviderAdapter>();

export function scriptedScriptPath(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[SCRIPTED_ENV];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function isScripted(env: Record<string, string | undefined> = process.env): boolean {
  return scriptedScriptPath(env) !== undefined;
}

export async function getAdapter(provider: ProviderId, opts: AdapterFactoryOptions): Promise<ProviderAdapter> {
  const env = opts.env ?? process.env;
  const script = scriptedScriptPath(env);
  if (script !== undefined) {
    let scripted = cache.get("scripted");
    if (scripted === undefined) {
      scripted = new ScriptedAdapter(script, env);
      cache.set("scripted", scripted);
    }
    return scripted;
  }
  if (provider === "scripted") throw new ProviderError(`provider 'scripted' requires ${SCRIPTED_ENV}.`, `Set ${SCRIPTED_ENV}=<script.jsonl> or configure a real provider.`, { provider });
  const existing = cache.get(provider);
  if (existing !== undefined) return existing;
  const key = opts.keys[provider];
  if (key === undefined) throw new ProviderError(`no API key resolved for provider '${provider}'.`, "Load the configuration with the role set that needs this provider.", { provider });
  const injected = opts.factories?.[provider];
  let adapter: ProviderAdapter;
  if (injected !== undefined) adapter = injected(key, opts.debug);
  else adapter = await constructLive(provider, key, opts.debug);
  cache.set(provider, adapter);
  return adapter;
}

async function constructLive(provider: KeyedProvider, key: KeyHandle, debug: DebugDumper | undefined): Promise<ProviderAdapter> {
  switch (provider) {
    case "openai": {
      const { OpenAIAdapter } = await import("./openai.ts");
      return new OpenAIAdapter(key, debug);
    }
    case "anthropic": {
      const { AnthropicAdapter } = await import("./anthropic.ts");
      return new AnthropicAdapter(key, debug);
    }
    case "zai": {
      const { ZaiAdapter } = await import("./zai.ts");
      return new ZaiAdapter(key, debug);
    }
    default:
      throw new ProviderError(`unknown provider '${String(provider)}'.`, "Expected openai, anthropic, or zai.", { provider: provider as ProviderId });
  }
}

export function adapterForRole(role: ResolvedRole, opts: AdapterFactoryOptions): Promise<ProviderAdapter> {
  return getAdapter(role.provider, opts);
}

export function resetAdapterCache(): void {
  cache.clear();
}

/** Filter provider endpoint IDs by the admit() exposure list. Undefined exposure = all providers (backward compatible). */
export function filterProviderEndpoints(providerIds: readonly string[], exposure?: readonly string[]): string[] {
  if (exposure === undefined) return [...providerIds];
  const set = new Set(exposure);
  return providerIds.filter((id) => set.has(id));
}

let egressCounter = 0;

/** Wraps an adapter.streamTurn call through the gate as model.invoke (H-01). */
export function egressModelInvoke(adapter: ProviderAdapter, gate: Gate, req: TurnRequest, signal?: AbortSignal, emit?: EmitFn): AsyncIterable<AdapterDelta> {
  const role = req.role;
  const descriptor = new EffectDescriptor({
    effect_id: `fx_model_${++egressCounter}`,
    kind: "model.invoke",
    target: `${role.provider}/${role.modelId}`,
    parameters: { model: role.modelId, provider: role.provider },
  });
  return egressStream(adapter, gate, descriptor, req, signal, emit);
}

/** Inner helper: dispatches the stream through the gate, then yields deltas. */
async function* egressStream(adapter: ProviderAdapter, gate: Gate, descriptor: EffectDescriptor, req: TurnRequest, signal?: AbortSignal, emit?: EmitFn): AsyncIterable<AdapterDelta> {
  let stream: AsyncIterable<AdapterDelta> | undefined;
  const result = await gate.egress(descriptor, async () => {
    if (emit !== undefined) {
      await emit({ ts: nowTs(), type: "model_called", model_ref: descriptor.target, prompt_hash: promptHash(req) } as AgentEvent, true);
    }
    stream = adapter.streamTurn(req, signal);
    // Consume one delta to confirm the stream opened, then return ok
    return { status: "ok", text: "stream opened" };
  });
  if (result.status === "blocked") {
    yield { kind: "notice", text: result.text };
    yield { kind: "usage", usage: { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, stopReason: "end", thinkingPayloads: [] };
    return;
  }
  if (stream === undefined) return;
  yield* stream;
}

/** FNV-1a hash of the request content for model_called.prompt_hash. */
function promptHash(req: TurnRequest): string {
  const content = JSON.stringify({
    system: req.system,
    tools: req.tools.map((t) => t.name),
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
