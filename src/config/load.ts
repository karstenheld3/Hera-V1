// Configuration loading and role resolution (HERAV1PRCF-SP01 FR-01, FR-02, FR-07; HERAV1PRCF-IP01 IS-04).
// Behavioral reference: V1 config.py (translate_effort, resolve_role, resolve_key).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "../errors.ts";
import { ROLE_NAMES, type ProviderId, type RoleName, type RoleOrAlias } from "../models.ts";
import { resolveUnderAppDir } from "./appdir.ts";
import { KEY_FILE_NAME, KeyHandle, missingKeyMessage, parseKeyFile, resolveKey, type KeyedProvider } from "./keys.ts";
import { detectMixed, detectRemovedKeys, isV1Shaped, migrateV1, type Raw } from "./migrate.ts";
import { defaultConfigText, parseHeraConfig, validateCompactionBound, type HeraConfig, type RoleSpec } from "./schema.ts";

export const PARAM_METHODS = ["temperature", "reasoning_effort", "thinking", "adaptive_thinking", "effort"] as const;
export type ParamMethod = (typeof PARAM_METHODS)[number];

export interface RegistryModel {
  provider: string;
  model_id: string;
  name?: string;
  context_window?: number;
  enabled: boolean;
  status?: string;
}

export interface PrefixEntry {
  prefix: string;
  provider: string;
  method: ParamMethod;
  max_input?: number | null;
  max_output?: number | null;
  temp_max?: number;
  thinking_max?: number;
  effort?: string[];
  default?: string;
  beta?: string;
  seed?: boolean;
}

export interface ModelRegistry {
  models: RegistryModel[];
  model_id_startswith: PrefixEntry[];
}

export interface EffortFactors {
  temperature_factor: number;
  openai_reasoning_effort: string;
  openai_verbosity?: string;
  anthropic_thinking_factor: number;
  anthropic_adaptive_effort: string;
  output_length_factor?: number;
}

export interface ParameterMapping {
  effort_levels: string[];
  effort_mapping: Record<string, EffortFactors>;
}

export interface ModelPrice {
  input_per_1m: number;
  cached_per_1m?: number;
  output_per_1m: number;
  cache_write_per_1m?: number;
  currency?: string;
}

export type PricingTable = Record<string, Record<string, ModelPrice>>;

/** Provider-neutral call parameters translated from the effort level (V1 translate_effort shape). */
export type EffortParams =
  | { method: "temperature"; temperature: number }
  | { method: "reasoning_effort"; reasoning_effort: string }
  | { method: "thinking"; thinking_budget: number }
  | { method: "adaptive_thinking"; effort: string }
  | { method: "effort"; effort: string; beta?: string };

export interface ResolvedRole {
  name: RoleOrAlias;
  modelId: string;
  provider: ProviderId;
  method: ParamMethod;
  effort: string;
  params: EffortParams;
  maxInput: number | null;
  maxOutput: number;
  contextWindow: number | null;
  /** true when the alias resolved to the compacting role (websearch absent) */
  aliasOf?: RoleName;
}

export interface LoadOptions {
  appDir: string;
  /** explicit --config / AGENT_CONFIG path; undefined = <appDir>/.agent-data/config/agent-config.json with auto-creation */
  configPath?: string | undefined;
  /** roles whose provider keys this process needs (FR-07); "all" for every role */
  roles: readonly RoleOrAlias[] | "all";
  requireKeys: boolean;
  /** HERA_SCRIPTED_ADAPTER set: key resolution skipped */
  scripted: boolean;
  env?: Record<string, string | undefined>;
  /** injected for tests: records which providers were resolved */
  onResolveKey?(provider: KeyedProvider): void;
}

export interface ResolvedConfig {
  config: HeraConfig;
  configPath: string;
  configDir: string;
  appDir: string;
  agentFolder: string;
  dataDir: string;
  keyFilePath: string;
  /** every role (five) plus the websearch alias target, resolved against the registry */
  roles: Record<RoleName, ResolvedRole> & { websearch: ResolvedRole };
  keys: Partial<Record<KeyedProvider, KeyHandle>>;
  pricing: PricingTable;
  registry: ModelRegistry;
  mapping: ParameterMapping;
  notices: string[];
  migrated: boolean;
  created: string[];
}

export const ROLE_SETS: Record<"communicator" | "executor" | "supervisor", readonly RoleOrAlias[]> = {
  communicator: [],
  executor: ["generating", "compacting", "websearch"],
  supervisor: ["supervisor", "memory"],
};

function readJsonFile(path: string, what: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError(`${what} '${path}' not found.`, "The file ships with Hera; restore it from the distribution or point --app-dir at the folder that contains config/.");
  }
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${what} '${path}' is not valid JSON (${error instanceof Error ? error.message : String(error)}).`, "Fix the JSON syntax.");
  }
}

const allowedLevelsFor = (entry: PrefixEntry, mapping: ParameterMapping): string[] => entry.effort ?? (entry.method === "temperature" || entry.method === "thinking" ? ["low", "medium", "high"] : mapping.effort_levels);

/** Port of V1 translate_effort(): effort level → provider-neutral params for the five methods. */
export function translateEffort(entry: PrefixEntry, effort: string, mapping: ParameterMapping, roleLabel: string, fileLabel: string): EffortParams {
  const allowed = allowedLevelsFor(entry, mapping);
  const factors = mapping.effort_mapping[effort];
  if (factors === undefined || !allowed.includes(effort)) {
    throw new ConfigError(`${fileLabel}: ${roleLabel}.effort '${effort}' is not allowed for model prefix '${entry.prefix}' (method ${entry.method}).`, `Use one of: ${allowed.join(", ")}.`);
  }
  switch (entry.method) {
    case "temperature":
      return { method: "temperature", temperature: Math.round(factors.temperature_factor * (entry.temp_max ?? 1.0) * 100) / 100 };
    case "reasoning_effort":
      return { method: "reasoning_effort", reasoning_effort: factors.openai_reasoning_effort };
    case "thinking":
      return { method: "thinking", thinking_budget: Math.floor(factors.anthropic_thinking_factor * (entry.thinking_max ?? 0)) };
    case "adaptive_thinking":
      return { method: "adaptive_thinking", effort: factors.anthropic_adaptive_effort };
    case "effort":
      return entry.beta !== undefined ? { method: "effort", effort: factors.anthropic_adaptive_effort, beta: entry.beta } : { method: "effort", effort: factors.anthropic_adaptive_effort };
    default:
      throw new ConfigError(`model-registry.json: unknown parameter method '${String(entry.method)}' for prefix '${entry.prefix}'.`, `Expected one of: ${PARAM_METHODS.join(", ")}.`);
  }
}

export function resolveRole(name: RoleOrAlias, spec: RoleSpec, registry: ModelRegistry, mapping: ParameterMapping, fileLabel: string): ResolvedRole {
  const roleLabel = `roles.${name}`;
  const model = registry.models.find((m) => m.model_id === spec.model_id);
  const enabledCount = registry.models.filter((m) => m.enabled).length;
  if (model === undefined) {
    throw new ConfigError(`${fileLabel}: ${roleLabel}.model_id '${spec.model_id}' is not in model-registry.json.`, `Add it there or choose an enabled model (${enabledCount} enabled).`);
  }
  if (!model.enabled) {
    throw new ConfigError(`${fileLabel}: ${roleLabel}.model_id '${spec.model_id}' is disabled in model-registry.json (status ${model.status ?? "unknown"}).`, `Enable it there or choose an enabled model (${enabledCount} enabled).`);
  }
  let entry: PrefixEntry | undefined;
  for (const candidate of registry.model_id_startswith) {
    if (spec.model_id.startsWith(candidate.prefix) && (entry === undefined || candidate.prefix.length > entry.prefix.length)) entry = candidate;
  }
  if (entry === undefined) {
    throw new ConfigError(`${fileLabel}: ${roleLabel}.model_id '${spec.model_id}' matches no model_id_startswith prefix in model-registry.json.`, "Add a prefix entry for this model family.");
  }
  const params = translateEffort(entry, spec.effort, mapping, roleLabel, fileLabel);
  const provider = model.provider as ProviderId;
  return {
    name,
    modelId: spec.model_id,
    provider,
    method: entry.method,
    effort: spec.effort,
    params,
    maxInput: entry.max_input ?? model.context_window ?? null,
    maxOutput: entry.max_output ?? 8192,
    contextWindow: model.context_window ?? null,
  };
}

/** Reads or creates the config file, migrates a V1 shape in memory, validates, resolves roles and keys (IG-04: all errors before spawn). */
export function loadConfig(opts: LoadOptions): ResolvedConfig {
  const env = opts.env ?? process.env;
  const notices: string[] = [];
  const created: string[] = [];
  const explicit = opts.configPath !== undefined;
  const configPath = opts.configPath ?? join(opts.appDir, ".agent-data", "config", "agent-config.json");
  const configDir = dirname(configPath);
  const fileLabel = "agent-config.json";

  if (!existsSync(configPath)) {
    if (explicit) throw new ConfigError(`config file '${configPath}' not found.`, "Create it or fix the --config / AGENT_CONFIG path (an explicit path is never auto-created).");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, defaultConfigText());
    created.push(configPath);
    notices.push(`Created '${configPath}' with defaults.`);
  }

  let raw = readJsonFile(configPath, "config file");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError(`${fileLabel}: top level must be a JSON object.`, "Start the file with '{'.");
  let migrated = false;
  const record = raw as Record<string, unknown>;
  detectMixed(record, fileLabel);
  if (isV1Shaped(record)) {
    const m = migrateV1(record);
    raw = m.config;
    notices.push(m.notice);
    migrated = true;
  }
  detectRemovedKeys(raw as Raw, notices);
  const parsed = parseHeraConfig(raw, fileLabel);
  notices.push(...parsed.notices);
  const config = parsed.config;

  const registry = readJsonFile(join(configDir, "model-registry.json"), "model registry") as ModelRegistry;
  const mapping = readJsonFile(join(configDir, "model-parameter-mapping.json"), "parameter mapping") as ParameterMapping;
  const pricingFile = readJsonFile(join(configDir, "model-pricing.json"), "pricing file") as { pricing?: PricingTable };
  const pricing = pricingFile.pricing ?? {};

  const resolved = {} as Record<RoleName, ResolvedRole> & { websearch: ResolvedRole };
  for (const role of ROLE_NAMES) resolved[role] = resolveRole(role, config.roles[role], registry, mapping, fileLabel);
  if (config.roles.websearch !== undefined) {
    resolved.websearch = resolveRole("websearch", config.roles.websearch, registry, mapping, fileLabel);
  } else {
    resolved.websearch = { ...resolved.compacting, name: "websearch", aliasOf: "compacting" };
  }

  const genMaxInput = resolved.generating.maxInput ?? resolved.generating.contextWindow ?? 128000;
  const threshold = Math.min(Math.floor(config.compaction_threshold_fraction * genMaxInput), config.compaction_threshold_max_tokens);
  const boundNotice = validateCompactionBound(threshold, resolved.generating.maxOutput, config.tool_result_max_chars, genMaxInput);
  if (boundNotice !== undefined) notices.push(boundNotice);

  const requested = opts.roles === "all" ? ([...ROLE_NAMES, "websearch"] as RoleOrAlias[]) : opts.roles;
  const keyFilePath = join(configDir, KEY_FILE_NAME);
  const keys: Partial<Record<KeyedProvider, KeyHandle>> = {};
  if (!opts.scripted && opts.requireKeys) {
    const allowFile = config.keys.allow_file;
    const fileParse = allowFile && existsSync(keyFilePath) ? parseKeyFile(readFileSync(keyFilePath, "utf8"), keyFilePath) : { entries: {}, warnings: [] };
    notices.push(...fileParse.warnings);
    const providers = new Set<KeyedProvider>();
    for (const role of requested) {
      const p = resolved[role].provider;
      if (p !== "scripted") providers.add(p);
    }
    for (const provider of providers) {
      opts.onResolveKey?.(provider);
      const handle = resolveKey(provider, env, fileParse.entries);
      if (handle === undefined) {
        const { message, action } = missingKeyMessage(provider, keyFilePath, allowFile);
        throw new ConfigError(message, action);
      }
      keys[provider] = handle;
    }
  }

  return {
    config,
    configPath,
    configDir,
    appDir: opts.appDir,
    agentFolder: resolveUnderAppDir(opts.appDir, config.agent_folder),
    dataDir: resolveUnderAppDir(opts.appDir, config.data_dir),
    keyFilePath,
    roles: resolved,
    keys,
    pricing,
    registry,
    mapping,
    notices,
    migrated,
    created,
  };
}

/** `Hera 2.0.0 | generating: glm-5.2 (high) | compacting: gpt-4.1-mini (low) | ...` */
export function rolesSummary(resolved: ResolvedConfig): string {
  return ROLE_NAMES.map((r) => `${r}: ${resolved.roles[r].modelId} (${resolved.roles[r].effort})`).join(" | ");
}
