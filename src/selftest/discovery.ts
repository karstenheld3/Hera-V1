// Model discovery for the live categories (HERAV1STST-SP01 FR-06, FR-13, DD-04; HERAV1STST-IP01 IS-03). Uses the
// loader's registry, mapping, and pricing - never a second implementation of prefix matching or pricing.

import type { ModelRegistry, ParamMethod, ParameterMapping, PrefixEntry, PricingTable, RegistryModel, ResolvedConfig, ResolvedRole } from "../config/load.ts";
import { resolveRole } from "../config/load.ts";
import type { KeyedProvider } from "../config/keys.ts";
import { priceFor } from "../cost.ts";

export interface TestableModel {
  model: RegistryModel;
  entry: PrefixEntry;
  provider: KeyedProvider;
  method: ParamMethod;
  defaultEffort: string;
  levels: string[];
  inputPricePer1m: number | undefined;
  /** false when the provider key is absent: the test is pre-marked skip, never fail (IG-02) */
  keyPresent: boolean;
}

export interface DiscoveryFilters {
  provider?: string | undefined;
  model?: string | undefined;
}

export interface Discovery {
  testable: TestableModel[];
  warnings: string[];
}

/** Longest prefix match, the loader's rule (HERAV1PRCF-SP01 FR-05). */
export function prefixFor(modelId: string, registry: ModelRegistry): PrefixEntry | undefined {
  let best: PrefixEntry | undefined;
  for (const entry of registry.model_id_startswith) {
    if (modelId.startsWith(entry.prefix) && (best === undefined || entry.prefix.length > best.prefix.length)) best = entry;
  }
  return best;
}

export function levelsFor(entry: PrefixEntry, mapping: ParameterMapping): string[] {
  return entry.effort ?? (entry.method === "temperature" || entry.method === "thinking" ? ["low", "medium", "high"] : mapping.effort_levels);
}

/** Enabled and available registry models with a prefix entry, filtered by --provider / --model; key presence recorded per model. */
export function testableModels(registry: ModelRegistry, mapping: ParameterMapping, pricing: PricingTable, keysPresent: Set<string>, filters: DiscoveryFilters = {}): Discovery {
  const warnings: string[] = [];
  const testable: TestableModel[] = [];
  for (const model of registry.models) {
    if (!model.enabled || (model.status !== undefined && model.status !== "available")) continue;
    if (filters.provider !== undefined && model.provider !== filters.provider) continue;
    if (filters.model !== undefined && model.model_id !== filters.model) continue;
    const entry = prefixFor(model.model_id, registry);
    if (entry === undefined) {
      warnings.push(`WARNING: model '${model.model_id}' has no model_id_startswith entry -> excluded from the sweep.`);
      continue;
    }
    const price = priceFor(pricing, model.provider, model.model_id);
    const levels = levelsFor(entry, mapping);
    const defaultEffort = entry.default !== undefined && levels.includes(entry.default) ? entry.default : levels.includes("medium") ? "medium" : (levels[0] ?? "medium");
    testable.push({ model, entry, provider: model.provider as KeyedProvider, method: entry.method, defaultEffort, levels, inputPricePer1m: price?.input_per_1m, keyPresent: keysPresent.has(model.provider) });
  }
  return { testable, warnings };
}

/** DD-04: the cheapest model (by input price) per parameter method; unpriced models never win. */
export function cheapestPerMethod(testable: TestableModel[]): Map<ParamMethod, TestableModel> {
  const out = new Map<ParamMethod, TestableModel>();
  for (const t of testable) {
    if (t.inputPricePer1m === undefined) continue;
    const current = out.get(t.method);
    if (current === undefined || (current.inputPricePer1m as number) > t.inputPricePer1m) out.set(t.method, t);
  }
  return out;
}

/** Category 06: per provider the configured generating model when it belongs to the provider, else the cheapest testable model. */
export function modelPerProvider(config: ResolvedConfig, testable: TestableModel[]): Map<KeyedProvider, TestableModel> {
  const out = new Map<KeyedProvider, TestableModel>();
  const generating = config.roles.generating;
  for (const t of testable) {
    if (t.provider === generating.provider && t.model.model_id === generating.modelId) out.set(t.provider, t);
  }
  for (const t of testable) {
    if (out.has(t.provider)) continue;
    const cheaper = [...testable].filter((x) => x.provider === t.provider && x.inputPricePer1m !== undefined).sort((a, b) => (a.inputPricePer1m as number) - (b.inputPricePer1m as number))[0];
    out.set(t.provider, cheaper ?? t);
  }
  return out;
}

/** A ResolvedRole for an arbitrary testable model at a given effort (the sweep, the matrix): the loader's resolveRole, not a copy. */
export function roleFor(t: TestableModel, effort: string, config: ResolvedConfig, label = "selftest"): ResolvedRole {
  return resolveRole("generating", { model_id: t.model.model_id, effort }, config.registry, config.mapping, label);
}
