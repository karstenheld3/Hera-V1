// Category 02 Configuration (HERAV1STST-SP01 FR-04; HERAV1STST-IP01 IS-04): the loader in report mode (keys reported,
// never required), the four roles with `(default)` marks, the websearch alias, key presence per used provider (never
// values), pricing coverage of enabled models, effective supervisor and ipc values.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_VARS, type KeyedProvider } from "../../config/keys.ts";
import { loadConfig, type ResolvedConfig } from "../../config/load.ts";
import { DEFAULT_CONFIG, DEFAULT_ROLES } from "../../config/schema.ts";
import { priceFor } from "../../cost.ts";
import { ROLE_NAMES } from "../../models.ts";
import { getAdapter } from "../../providers/registry.ts";
import type { TestResult } from "../report.ts";
import type { SelftestContext } from "../runner.ts";

const ok = (check: string, detail: string, warning?: string): TestResult => ({ category: "02", check, status: "pass", duration_seconds: 0, detail, error_message: null, ...(warning !== undefined ? { warning } : {}) });
const fail = (check: string, detail: string, error: string): TestResult => ({ category: "02", check, status: "fail", duration_seconds: 0, detail, error_message: error });

export async function configurationCategory(ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];
  let config: ResolvedConfig;
  try {
    // report mode: the loader with requireKeys=false; a fresh load reports Created/migrated states for THIS category
    config = loadConfig({ appDir: ctx.appDir, configPath: ctx.args === undefined ? undefined : ctx.config.configPath, roles: "all", requireKeys: false, scripted: ctx.scripted, env: ctx.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push(fail("agent-config.json", "invalid", message));
    ctx.out(`  agent-config.json: ${message}...FAIL`);
    return results;
  }
  const created = config.created.some((c) => c.endsWith("agent-config.json"));
  const state = created ? "created with defaults (zero-setup)" : config.migrated ? "V1-shaped, migrated in memory" : "V2 shape";
  results.push(ok("agent-config.json", state, config.migrated ? config.notices.find((n) => n.startsWith("NOTICE:")) : undefined));
  ctx.out(`  agent-config.json: ${state}...OK${config.migrated ? " (warning)" : ""}`);

  const roleParts: string[] = [];
  for (const role of ROLE_NAMES) {
    const r = config.roles[role];
    const isDefault = config.notices.some((n) => n.includes(`role '${role}' not configured`)) && DEFAULT_ROLES[role]?.model_id === r.modelId;
    roleParts.push(`${role} ${r.modelId} (${r.effort}${isDefault ? ", default" : ""})`);
    results.push(ok(`role_${role}`, `${r.provider} ${r.modelId} ${r.method} ${r.effort}${isDefault ? " (default)" : ""}`));
  }
  ctx.out(`  roles: ${roleParts.join(" | ")}...OK`);

  const ws = config.roles.websearch;
  let supportsSearch = "unknown";
  try {
    const adapter = await getAdapter(ws.provider, { keys: config.keys, env: ctx.env });
    supportsSearch = adapter.supportsWebSearch() ? "web search supported" : "web search NOT supported";
  } catch (error) {
    supportsSearch = `adapter unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
  const alias = ws.aliasOf !== undefined ? `alias -> ${ws.aliasOf}` : "configured";
  results.push(ok("websearch", `${alias} (${ws.provider}, ${supportsSearch})`));
  ctx.out(`  websearch: ${alias} (${ws.provider}, ${supportsSearch})...OK`);

  const used = new Set<string>(Object.values(config.roles).map((r) => r.provider));
  const keyParts: string[] = [];
  let missing = 0;
  for (const provider of Object.keys(KEY_VARS) as KeyedProvider[]) {
    const present = config.keys[provider] !== undefined;
    const label = used.has(provider) ? (present ? "present" : "missing") : "unused";
    if (label === "missing") missing++;
    keyParts.push(`${provider} ${label}`);
  }
  const keysDetail = keyParts.join(", ");
  results.push(ok("keys", keysDetail, missing > 0 && !ctx.scripted ? `${missing} used provider(s) without a key - live categories skip them` : undefined));
  ctx.out(`  keys: ${keysDetail}...OK${missing > 0 && !ctx.scripted ? " (warning)" : ""}`);

  const enabled = config.registry.models.filter((m) => m.enabled && (m.status === undefined || m.status === "available"));
  const priced = enabled.filter((m) => priceFor(config.pricing, m.provider, m.model_id) !== undefined).length;
  const pricingDetail = `${priced} of ${enabled.length} enabled models priced`;
  results.push(priced === enabled.length ? ok("pricing", pricingDetail) : ok("pricing", pricingDetail, `${enabled.length - priced} enabled model(s) without a pricing entry`));
  ctx.out(`  pricing: ${pricingDetail}...OK${priced === enabled.length ? "" : " (warning)"}`);

  for (const file of ["model-registry.json", "model-parameter-mapping.json", "model-pricing.json"]) {
    const path = join(config.configDir, file);
    if (!existsSync(path)) {
      results.push(fail(file, "missing", `${path} not found`));
      continue;
    }
    try {
      JSON.parse(readFileSync(path, "utf8"));
      results.push(ok(file, "parses"));
    } catch (error) {
      results.push(fail(file, "invalid JSON", error instanceof Error ? error.message : String(error)));
    }
  }
  ctx.out(`  files: registry, mapping, pricing parse...${results.filter((r) => r.check.endsWith(".json") && r.status === "fail").length === 0 ? "OK" : "FAIL"}`);

  const sup = config.config.supervisor;
  const dsup = DEFAULT_CONFIG.supervisor;
  const mark = (v: unknown, d: unknown): string => `${String(v)}${JSON.stringify(v) === JSON.stringify(d) ? " (default)" : ""}`;
  const supDetail = `stall_timeout_s ${mark(sup.stall_timeout_s, dsup.stall_timeout_s)}, review_every_calls ${mark(sup.review_every_calls, dsup.review_every_calls)}, cost_alert_usd ${mark(sup.cost_alert_usd, dsup.cost_alert_usd)}, denylist ${sup.denylist.length} entries`;
  results.push(ok("supervisor", supDetail));
  ctx.out(`  supervisor: ${supDetail}...OK`);
  const ipc = config.config.ipc;
  const dipc = DEFAULT_CONFIG.ipc;
  const ipcDetail = `heartbeat_s ${mark(ipc.heartbeat_s, dipc.heartbeat_s)}, ack_timeout_ms ${mark(ipc.ack_timeout_ms, dipc.ack_timeout_ms)}, hello_timeout_ms ${mark(ipc.hello_timeout_ms, dipc.hello_timeout_ms)}, shutdown_timeout_ms ${mark(ipc.shutdown_timeout_ms, dipc.shutdown_timeout_ms)}, restart_budget ${mark(ipc.restart_budget, dipc.restart_budget)}`;
  results.push(ok("ipc", ipcDetail));
  ctx.out(`  ipc: ${ipcDetail}...OK`);
  return results;
}
