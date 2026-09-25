// Selftest runner (HERAV1STST-SP01 FR-01, FR-02, FR-12..FR-15; HERAV1STST-IP01 IS-01, IS-03). `hera selftest` parses its
// own arguments, expands `all|offline|live`, runs categories in ascending order under a budget and per-test timeout,
// writes results.json on every exit path (Ctrl+C included), and exits 0 only with zero fail and zero error.

import type { ParsedArgs } from "../args.ts";
import { resolveAppDir } from "../config/appdir.ts";
import type { KeyedProvider } from "../config/keys.ts";
import { loadConfig, type ResolvedConfig, type ResolvedRole } from "../config/load.ts";
import { computeCost, formatUsd, priceFor } from "../cost.ts";
import { ConfigError } from "../errors.ts";
import { materialize } from "../bundled/index.ts";
import type { Message, ToolDefinition, Usage } from "../models.ts";
import type { AdapterDelta, ProviderAdapter } from "../providers/base.ts";
import { getAdapter, isScripted, resetAdapterCache, egressModelInvoke } from "../providers/registry.ts";
import { Gate } from "../harness/gate.ts";
import { PassThroughPlug } from "../harness/plugs/passthrough.ts";
import { environmentCategory } from "./categories/01_environment.ts";
import { configurationCategory } from "./categories/02_configuration.ts";
import { promptSystemCategory } from "./categories/03_prompt_system.ts";
import { modelSweepCategory } from "./categories/04_model_sweep.ts";
import { effortMatrixCategory } from "./categories/05_effort_matrix.ts";
import { toolCallsCategory } from "./categories/06_tool_calls.ts";
import { processHealthCategory } from "./categories/07_process_health.ts";
import { rolesCategory } from "./categories/08_roles.ts";
import { harnessCategory } from "./categories/09_harness.ts";
import { localGuardsCategory } from "./categories/10_localguards.ts";
import { testableModels, type Discovery } from "./discovery.ts";
import { ResultsWriter, USAGE_LINE, categorySummaryLine, checkLine, exitCodeFor, menuText, resultLine, summarize, type CategoryInfo, type TestResult, type TestStatus } from "./report.ts";

export interface SelftestArgs {
  codes: string[];
  menu: boolean;
  provider: string | undefined;
  model: string | undefined;
  budgetUsd: number;
  timeoutS: number;
  deadlineS: number;
}

export const OFFLINE_CODES = ["01", "02", "03", "07", "09", "10"];
export const LIVE_CODES = ["04", "05", "06", "08"];
export const ALL_CODES = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"];
export const MINIMAL_SYSTEM = "You are a test agent. Respond with exactly: SELFTEST OK";
export const MINIMAL_USER = "Respond now.";

/** Parses everything after `selftest`; invalid codes exit 2 with the valid list (EC-02). */
export function parseSelftestArgs(argv: string[]): SelftestArgs {
  const out: SelftestArgs = { codes: [], menu: false, provider: undefined, model: undefined, budgetUsd: 5.0, timeoutS: 60, deadlineS: 0 };
  const rest = argv[0] === "selftest" ? argv.slice(1) : argv;
  const codes = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const value = (): string => {
      const v = rest[i + 1];
      if (v === undefined) throw new ConfigError(`option '${arg}' requires a value.`, "");
      i++;
      return v;
    };
    if (arg === "--menu") out.menu = true;
    else if (arg === "--provider") out.provider = value();
    else if (arg === "--model") out.model = value();
    else if (arg === "--budget") {
      const n = Number(value());
      if (!Number.isFinite(n) || n < 0) throw new ConfigError(`option '--budget' expects a non-negative number.`, "");
      out.budgetUsd = n;
    } else if (arg === "--timeout") {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`option '--timeout' expects a positive number of seconds.`, "");
      out.timeoutS = n;
    } else if (arg === "--deadline") {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`option '--deadline' expects a positive number of seconds.`, "");
      out.deadlineS = n;
    } else if (arg === "all") for (const c of ALL_CODES) codes.add(c);
    else if (arg === "offline") for (const c of OFFLINE_CODES) codes.add(c);
    else if (arg === "live") for (const c of LIVE_CODES) codes.add(c);
    else if (ALL_CODES.includes(arg)) codes.add(arg);
    else throw new ConfigError(`unknown category '${arg}'. Valid: ${ALL_CODES.join(" ")} | all | offline | live`, "");
  }
  out.codes = [...codes].sort();
  return out;
}

export class Budget {
  spent = 0;
  constructor(readonly limitUsd: number) {}
  /** IG-01: checked before every live test; under 0.01 USD remaining nothing starts. */
  beforeTest(): boolean {
    return this.limitUsd - this.spent >= 0.01;
  }
  record(costUsd: number | undefined): void {
    this.spent = Math.round((this.spent + (costUsd ?? 0)) * 1e6) / 1e6;
  }
  get remaining(): number {
    return Math.max(0, this.limitUsd - this.spent);
  }
}

export interface SelftestContext {
  args: SelftestArgs;
  appDir: string;
  config: ResolvedConfig;
  scripted: boolean;
  keysPresent: Set<string>;
  discovery: Discovery;
  budget: Budget;
  timeoutMs: number;
  results: ResultsWriter;
  out: (line: string) => void;
  signal: AbortSignal;
  env: Record<string, string | undefined>;
  adapterFor(role: ResolvedRole): Promise<ProviderAdapter>;
  /** gate socket for model.invoke (passthrough profile in selftest) */
  gate: Gate;
  /** test hook: the entry script for spawned children (category 07) */
  entryMain?: string;
}

export interface Category extends CategoryInfo {
  run(ctx: SelftestContext): Promise<TestResult[]>;
}

const estimate = (usd: number): string => "$" + usd.toFixed(2);

export function categories(discovery: Discovery | undefined): Category[] {
  const models = discovery?.testable.length ?? 0;
  const methods = discovery === undefined ? 0 : new Set(discovery.testable.map((t) => t.method)).size;
  const providers = discovery === undefined ? 0 : new Set(discovery.testable.map((t) => t.provider)).size;
  return [
    { code: "01", name: "Environment", costClass: "offline", estimate: "free", run: environmentCategory },
    { code: "02", name: "Configuration", costClass: "offline", estimate: "free", run: configurationCategory },
    { code: "03", name: "Prompt System", costClass: "offline", estimate: "free", run: promptSystemCategory },
    { code: "04", name: "Model Sweep", costClass: "live", estimate: `~${estimate(models * 0.004)} (${models} models)`, run: modelSweepCategory },
    { code: "05", name: "Model Effort Matrix", costClass: "live", estimate: `~${estimate(methods * 0.04)} (${methods} methods)`, run: effortMatrixCategory },
    { code: "06", name: "Model Tool Calls", costClass: "live", estimate: `~${estimate(providers * 0.017)} (${providers} models)`, run: toolCallsCategory },
    { code: "07", name: "Process Health", costClass: "offline", estimate: "free", run: processHealthCategory },
    { code: "08", name: "Roles", costClass: "live", estimate: "~$0.02 (4 roles)", run: rolesCategory },
    { code: "09", name: "Harness Conformance", costClass: "offline", estimate: "free", run: harnessCategory },
    { code: "10", name: "LocalGuards Controls", costClass: "offline", estimate: "free", run: localGuardsCategory },
  ];
}

// ------------------------------------------------------------------ shared live round trip (IS-06)

export interface RoundTripOutcome {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> | undefined; argsJson: string }>;
  usage: Usage;
  stopReason: string;
  costUsd: number | undefined;
  durationMs: number;
}

/** One adapter call with the per-test timeout (AbortSignal) - the same adapter and cost formula the processes use. */
export async function roundTrip(ctx: SelftestContext, role: ResolvedRole, req: { system: string; user?: string; messages?: Message[]; tools?: ToolDefinition[] }): Promise<RoundTripOutcome> {
  const adapter = await ctx.adapterFor(role);
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  ctx.signal.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  const started = performance.now();
  let text = "";
  const toolCalls: RoundTripOutcome["toolCalls"] = [];
  let usage: Usage = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let stopReason = "end";
  try {
    const messages: Message[] = req.messages ?? [{ role: "user", content: req.user ?? MINIMAL_USER }];
    const consume = async (): Promise<void> => {
      const stream = egressModelInvoke(adapter, ctx.gate, { system: req.system, tools: req.tools ?? [], messages, role }, controller.signal);
      for await (const delta of stream as AsyncIterable<AdapterDelta>) {
        if (delta.kind === "text") text += delta.text;
        else if (delta.kind === "tool_call") toolCalls.push({ name: delta.toolCall.name, args: delta.toolCall.args, argsJson: delta.toolCall.argsJson });
        else if (delta.kind === "usage") {
          usage = delta.usage;
          stopReason = delta.stopReason;
        }
      }
    };
    // the abort also cuts the wait when an adapter only checks the signal between deltas (FR-15: the duration is the timeout)
    const aborted = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    await Promise.race([consume(), aborted]);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onOuterAbort);
  }
  const durationMs = performance.now() - started;
  if (controller.signal.aborted && !ctx.signal.aborted) throw new Error(`timeout after ${Math.round(ctx.timeoutMs / 1000)} s`);
  return { text, toolCalls, usage, stopReason, costUsd: computeCost(usage, priceFor(ctx.config.pricing, role.provider, role.modelId)), durationMs };
}

/** Builds a live TestResult; the budget is charged with the real cost. */
export function liveResult(ctx: SelftestContext, base: Omit<TestResult, "status" | "duration_seconds" | "error_message">, outcome: RoundTripOutcome, failure: string | undefined): TestResult {
  ctx.budget.record(outcome.costUsd);
  return {
    ...base,
    status: failure === undefined ? "pass" : "fail",
    duration_seconds: Math.round(outcome.durationMs / 100) / 10,
    usage: { uncached_input: outcome.usage.uncachedInput, cache_write: outcome.usage.cacheWrite, cache_read: outcome.usage.cacheRead, output: outcome.usage.output },
    cost_usd: outcome.costUsd ?? 0,
    error_message: failure ?? null,
  };
}

export const usageLine = (o: RoundTripOutcome): string => `${o.usage.uncachedInput + o.usage.cacheRead + o.usage.cacheWrite}in/${o.usage.output}out ${formatUsd(o.costUsd)} ${(o.durationMs / 1000).toFixed(1)}s`;

/** Wraps one live test: budget gate, skip without key, timeout and errors as fail with the duration. */
export async function runLive(ctx: SelftestContext, base: Omit<TestResult, "status" | "duration_seconds" | "error_message">, label: string, keyPresent: boolean, call: () => Promise<{ outcome: RoundTripOutcome; failure: string | undefined }>, index?: { i: number; n: number }): Promise<TestResult> {
  const prefix = index !== undefined ? `  [ ${index.i} / ${index.n} ] ` : "  ";
  ctx.out(`${prefix}${label}...`);
  if (!keyPresent && !ctx.scripted) {
    ctx.out(`    SKIP: no API key for ${base.provider ?? "provider"}`);
    return { ...base, status: "skip", duration_seconds: 0, error_message: null, detail: "no API key" };
  }
  if (!ctx.budget.beforeTest()) {
    ctx.out(`    BUDGET: ${formatUsd(ctx.budget.remaining)} of ${formatUsd(ctx.budget.limitUsd)} left - not started`);
    return { ...base, status: "budget_exceeded", duration_seconds: 0, error_message: null };
  }
  const started = performance.now();
  try {
    const { outcome, failure } = await call();
    const result = liveResult(ctx, base, outcome, failure);
    ctx.out(failure === undefined ? `    OK. ${usageLine(outcome)}` : `    FAIL: ${failure} (${usageLine(outcome)})`);
    return result;
  } catch (error) {
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    const message = error instanceof Error ? error.message : String(error);
    const status: TestStatus = ctx.signal.aborted ? "error" : "fail";
    ctx.out(`    ${status === "error" ? "ERROR" : "FAIL"}: ${message}`);
    return { ...base, status, duration_seconds: seconds, error_message: message };
  }
}

// ------------------------------------------------------------------ entry

export interface SelftestIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** test hook: entry script for category 07 children */
  entryMain?: string;
  onSigint?: (handler: () => void) => void;
}

export async function selftestMain(args: ParsedArgs, io: SelftestIo = { out: (l) => void process.stdout.write(`${l}\n`), err: (l) => void process.stderr.write(`${l}\n`), onSigint: (h) => process.on("SIGINT", h) }): Promise<number> {
  const env = io.env ?? process.env;
  let parsed: SelftestArgs;
  try {
    parsed = parseSelftestArgs(args.positionals);
  } catch (error) {
    io.err(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    io.err(USAGE_LINE);
    return 2;
  }
  const scripted = isScripted(env);
  let config: ResolvedConfig | undefined;
  let appDir: string;
  try {
    appDir = resolveAppDir({ flag: args.appDir, env: env["AGENT_APP_DIR"], cwd: io.cwd ?? process.cwd() });
    materialize(appDir);
    config = loadConfig({ appDir, configPath: args.config ?? env["AGENT_CONFIG"], roles: "all", requireKeys: false, scripted, env });
  } catch (error) {
    // the menu and category 02 report config failures; a broken config must not hide the menu
    if (parsed.menu || parsed.codes.length === 0) {
      io.out(menuText(categories(undefined), scripted));
      return 0;
    }
    io.err(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const keysPresent = new Set<string>(Object.keys(config.keys));
  const discovery = testableModels(config.registry, config.mapping, config.pricing, keysPresent, { provider: parsed.provider, model: parsed.model });
  if (parsed.model !== undefined && discovery.testable.length === 0 && !config.registry.models.some((m) => m.model_id === parsed.model)) {
    io.err(`ERROR: unknown model '${parsed.model}' -> not in the model registry.`);
    return 2;
  }
  const cats = categories(discovery);
  if (parsed.menu || parsed.codes.length === 0) {
    io.out(menuText(cats, scripted));
    return 0;
  }
  const results = new ResultsWriter(config.dataDir, parsed.budgetUsd, scripted);
  if (results.fallbackWarning !== undefined) io.err(results.fallbackWarning);
  const abort = new AbortController();
  let interrupted = false;
  io.onSigint?.(() => {
    interrupted = true;
    abort.abort();
  });
  resetAdapterCache(); // a selftest run starts from a clean adapter set (scripted replay from line 1)
  const adapters = new Map<string, ProviderAdapter>();
  const gate = new Gate(new PassThroughPlug());
  const ctx: SelftestContext = {
    args: parsed,
    appDir,
    config,
    scripted,
    keysPresent,
    discovery,
    budget: new Budget(parsed.budgetUsd),
    timeoutMs: parsed.timeoutS * 1000,
    results,
    out: io.out,
    signal: abort.signal,
    env,
    gate,
    entryMain: io.entryMain,
    adapterFor: async (role) => {
      const key = role.provider;
      let adapter = adapters.get(key);
      if (adapter === undefined) {
        adapter = await getAdapter(role.provider, { keys: config.keys, env }); // harness-allow: U12 getAdapter()
        adapters.set(key, adapter);
      }
      return adapter;
    },
  };
  for (const w of discovery.warnings) io.out(w);
  try {
    const deadlineMs = parsed.deadlineS > 0 ? performance.now() + parsed.deadlineS * 1000 : 0;
    for (const code of parsed.codes) {
      if (abort.signal.aborted) break;
      if (deadlineMs > 0 && performance.now() >= deadlineMs) {
        io.out("DEADLINE: absolute deadline exceeded - stopping.");
        break;
      }
      const cat = cats.find((c) => c.code === code) as Category;
      io.out(cat.costClass === "live" ? `SELFTEST: ${cat.code} ${cat.name} | Budget: ${formatUsd(parsed.budgetUsd)}` : `SELFTEST: ${cat.code} ${cat.name}`);
      results.categoriesRun.push(code);
      let tests: TestResult[] = [];
      try {
        tests = await cat.run(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.out(`  ERROR: category ${code} aborted -> ${message}`);
        tests = [{ category: code, check: "category", status: "error", duration_seconds: 0, error_message: message }];
      }
      for (const t of tests) results.add(t);
      io.out(categorySummaryLine(cat.code, cat.name, tests));
    }
  } finally {
    const doc = results.flush(interrupted);
    io.out(resultLine(doc.summary, doc.cost_usd, doc.duration_seconds));
    io.out(`results.json: ${results.path}`);
  }
  return exitCodeFor(summarize(results.tests));
}

export { checkLine };
export type { KeyedProvider };
