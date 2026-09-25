// Supervisor core (HERAV1SUPV-SP01 FR-02..FR-07; HERAV1SUPV-IP01 IS-02, IS-06): verdicts on the hot path, watchdog and
// review triggers fed by relayed heartbeats and event copies, memory extraction at turn end and retrieval on the prompt
// copy, incremental re-seed of the session JSONL on session_open. The Supervisor never spawns, never sends cancel, and
// never writes the session JSONL.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, ROLE_SETS, type ResolvedConfig } from "../config/load.ts";
import { computeCost, priceFor } from "../cost.ts";
import { dlog } from "../debug/debuglog.ts";
import { fromJsonl, nowTs, type AgentEvent } from "../events.ts";
import { loadRules, type RuleFile } from "../prompt/loader.ts";
import { ChildRuntime, type RoleHandlers } from "../process/child.ts";
import type { PayloadOf } from "../process/envelope.ts";
import type { ProviderAdapter } from "../providers/base.ts";
import { getAdapter, isScripted, egressModelInvoke } from "../providers/registry.ts";
import { interventionEvent, roleUsageEvent, zeroCounters, type InterventionCounters, type InterventionKind } from "./events.ts";
import { MemoryStore, extractMemories, retrieveMemories, workspaceHash, type Memory } from "./memory.ts";
import { memorySecretPath } from "../config/appdir.ts";
import { ReviewTriggers, Reviewer, buildReviewInput, runReview, type TriggerReason } from "./review.ts";
import { StallWatchdog } from "./watchdog.ts";
import { UNTRUSTED_CONTENT_CLOSE, UNTRUSTED_CONTENT_OPEN } from "../models.ts";
import { Gate } from "../harness/gate.ts";
import { EffectDescriptor } from "../harness/descriptor.ts";
import { admit, runCtxToWire } from "../harness/admit.ts";
import { createPlug, computePlugHash } from "../harness/plugs/factory.ts";
import { computeDefinitionHash } from "../harness/definition_hash.ts";
import { configSnapshot } from "../executor/session.ts";
import type { EmitFn } from "../harness/sink.ts";

export interface SupervisorOptions {
  adapters?: { supervisor: ProviderAdapter; memory: ProviderAdapter };
  runtimeOptions?: ConstructorParameters<typeof ChildRuntime>[3];
  env?: Record<string, string | undefined>;
  /** test hook: watchdog clock */
  now?: () => number;
  /** test hook: custom gate plug */
  gatePlug?: import("../harness/provider.ts").GateProvider;
}

export interface SupervisorState {
  counters: InterventionCounters;
  reseedDone: boolean;
  turnIndex: number;
  memoriesLoaded: number;
}

export interface SupervisorHandle {
  runtime: ChildRuntime;
  state: () => SupervisorState | undefined;
  watchdog: () => StallWatchdog | undefined;
}

interface TurnCapture {
  userRequest: string;
  assistantText: string;
  toolNames: string[];
}

export function createSupervisor(epoch: number | undefined, opts: SupervisorOptions = {}): SupervisorHandle {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => Date.now());
  let config: ResolvedConfig | undefined;
  let rules: RuleFile[] = [];
  let store: MemoryStore | undefined;
  let adapters: { supervisor: ProviderAdapter; memory: ProviderAdapter } | undefined;
  let watchdog: StallWatchdog | undefined;
  let triggers: ReviewTriggers | undefined;
  let reviewer: Reviewer | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let sessionId = "";
  let workspace = "";
  let opened = false;
  let inFlightModelCalls = 0;
  let gate: Gate | undefined;
  const state: SupervisorState = { counters: zeroCounters(), reseedDone: false, turnIndex: 0, memoriesLoaded: 0 };
  let capture: TurnCapture = { userRequest: "", assistantText: "", toolNames: [] };
  let currentPromptId = "";
  let rt: ChildRuntime | undefined;

  const intervention = (kind: InterventionKind, text: string, extra: { toolCallId?: string; rule?: string } = {}): void => {
    state.counters[kind]++;
    void rt?.sendEvent(interventionEvent(kind, text, state.turnIndex, extra), true);
  };

  const roleCost = (role: "supervisor" | "memory", usage: { uncachedInput: number; cacheWrite: number; cacheRead: number; output: number }): number | undefined => {
    if (config === undefined) return undefined;
    const r = config.roles[role];
    return computeCost(usage, priceFor(config.pricing, r.provider, r.modelId));
  };

  const debug = (op: string, fields: Record<string, unknown> = {}): void => {
    dlog("sup", op, fields);
  };

  const onEventCopy = (event: AgentEvent): void => {
    watchdog?.onEvent(event);
    triggers?.onEvent(event, now());
    if (event.proc === "comm" && event.type === "error" && /^executor exited/.test(event.message)) watchdog?.reset();
    if (event.proc !== "exec") return;
    switch (event.type) {
      case "user_message":
        state.turnIndex++;
        currentPromptId = event.prompt_id ?? "";
        capture = { userRequest: extractRequest(event.content), assistantText: "", toolNames: [] };
        break;
      case "text_delta":
        capture.assistantText += event.text;
        break;
      case "tool_call_requested":
        capture.toolNames.push(event.tool);
        break;
      case "turn_finished":
        if (event.role === "generating") void extractAtTurnEnd({ ...capture });
        break;
      default:
        break;
    }
  };

  const extractAtTurnEnd = async (turn: TurnCapture): Promise<void> => {
    if (store === undefined || adapters === undefined || config === undefined || rt === undefined) return;
    const rt0 = rt;
    const emit: EmitFn = (event, awaitAck) => rt0.sendEvent(event, awaitAck ?? false);
    inFlightModelCalls++;
    const started = performance.now();
    try {
      const outcome = await extractMemories(store, turn, adapters.memory, config.roles.memory, sessionId, gate!, undefined, emit);
      if (outcome.call !== undefined) {
        await rt.sendEvent(roleUsageEvent("memory", outcome.call.usage, roleCost("memory", outcome.call.usage), outcome.call.request, outcome.call.text), false);
        dlog("llm", "response", { role: "memory", provider: config.roles.memory.provider, model: config.roles.memory.modelId, dur_ms: Math.round(performance.now() - started), in_tok: outcome.call.usage.uncachedInput, cache_read: outcome.call.usage.cacheRead, out_tok: outcome.call.usage.output, cost_usd: roleCost("memory", outcome.call.usage) ?? null, tool_calls: 0 });
      }
      debug("extract", { candidates: outcome.created.length + outcome.touched.length, new: outcome.created.length, merged: outcome.touched.length, dur_ms: Math.round(performance.now() - started) });
    } catch (error) {
      debug("store_error", { op: "extract", err: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    } finally {
      inFlightModelCalls--;
    }
  };

  const onPromptCopy = async (payload: PayloadOf<"prompt">): Promise<void> => {
    if (store === undefined || adapters === undefined || config === undefined || rt === undefined) return;
    if (store.size === 0) return;
    const rt0 = rt;
    const emit: EmitFn = (event, awaitAck) => rt0.sendEvent(event, awaitAck ?? false);
    inFlightModelCalls++;
    const started = performance.now();
    try {
      const outcome = await retrieveMemories(store, payload.text, config.config.supervisor.memory_top_k, adapters.memory, config.roles.memory, gate!, undefined, emit);
      if (outcome.call !== undefined) {
        await rt.sendEvent(roleUsageEvent("memory", outcome.call.usage, roleCost("memory", outcome.call.usage), outcome.call.request, outcome.call.text), false);
        dlog("llm", "response", { role: "memory", provider: config.roles.memory.provider, model: config.roles.memory.modelId, dur_ms: Math.round(performance.now() - started), in_tok: outcome.call.usage.uncachedInput, cache_read: outcome.call.usage.cacheRead, out_tok: outcome.call.usage.output, cost_usd: roleCost("memory", outcome.call.usage) ?? null, tool_calls: 0 });
      }
      debug("retrieve", { candidates: store.size, selected: outcome.selected.length, dur_ms: Math.round(performance.now() - started) });
      if (outcome.selected.length > 0) {
        const text = outcome.selected.map((m) => {
          const originKind = m.origin?.kind ?? "model";
          const shortSession = m.source_session.length > 8 ? m.source_session.slice(0, 8) : m.source_session;
          const label = `[memory ${m.id}, from session ${shortSession}, origin ${originKind}]`;
          return `${UNTRUSTED_CONTENT_OPEN}memory" ref="${m.id}">\n${label}\n${m.text}\n${UNTRUSTED_CONTENT_CLOSE}`;
        }).join("\n");
        rt.send("inject", { kind: "memory", text, memory_ids: outcome.selected.map((m) => m.id), prompt_id: currentPromptId }, "exec");
        debug("inject", { count: outcome.selected.length, bytes: Buffer.byteLength(text) });
      }
    } catch (error) {
      debug("store_error", { op: "retrieve", err: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    } finally {
      inFlightModelCalls--;
    }
  };

  const review = async (reasons: TriggerReason[]): Promise<void> => {
    if (triggers === undefined || adapters === undefined || config === undefined || rt === undefined || !state.reseedDone) return;
    const rt0 = rt;
    const emit: EmitFn = (event, awaitAck) => rt0.sendEvent(event, awaitAck ?? false);
    inFlightModelCalls++;
    const started = performance.now();
    try {
      const input = buildReviewInput(reasons, triggers.recentCalls, triggers.userRequest, triggers.turnCostUsd, rules);
      const covered = triggers.recentCalls.length;
      const outcome = await runReview(input, adapters.supervisor, config.roles.supervisor, gate!, undefined, emit);
      const cost = roleCost("supervisor", outcome.usage);
      await rt.sendEvent(roleUsageEvent("supervisor", outcome.usage, cost, outcome.request, outcome.text), false);
      dlog("llm", "response", { role: "supervisor", provider: config.roles.supervisor.provider, model: config.roles.supervisor.modelId, dur_ms: Math.round(performance.now() - started), in_tok: outcome.usage.uncachedInput, cache_read: outcome.usage.cacheRead, out_tok: outcome.usage.output, cost_usd: cost ?? null, tool_calls: 0 });
      if (outcome.note !== undefined) {
        rt.send("inject", { kind: "governance", text: outcome.note, prompt_id: currentPromptId }, "exec");
        intervention("governance_note", outcome.note);
      }
      debug("review", { trigger: reasons.join(","), calls: covered, outcome: outcome.note !== undefined ? "governance_note" : "no_action", dur_ms: Math.round(performance.now() - started), cost_usd: cost ?? null });
    } catch (error) {
      debug("store_error", { op: "review", err: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    } finally {
      inFlightModelCalls--;
    }
  };

  /** Incremental re-seed: counters from the existing JSONL, 1 MB chunks with yields. */
  const reseed = async (path: string): Promise<void> => {
    try {
      if (!existsSync(path)) return;
      const text = readFileSync(path, "utf8");
      const lines = text.split(/\r?\n/);
      let sinceReview = 0;
      let total = 0;
      let interventions = zeroCounters();
      let turns = 0;
      let budget = 0;
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        budget += line.length;
        if (budget > 1_000_000) {
          budget = 0;
          await Bun.sleep(0);
        }
        let event: AgentEvent;
        try {
          event = fromJsonl(line);
        } catch {
          continue;
        }
        if (event.type === "user_message") turns++;
        else if (event.type === "tool_call_requested") {
          total++;
          sinceReview++;
        } else if (event.type === "supervisor_intervention") {
          interventions[event.kind]++;
          if (event.kind === "governance_note") sinceReview = 0;
        }
      }
      state.counters = interventions;
      state.turnIndex = turns;
      triggers?.seedCallCount(sinceReview % Math.max(1, config?.config.supervisor.review_every_calls ?? 10), total);
      if (triggers !== undefined) triggers.turnIndex = turns;
    } finally {
      state.reseedDone = true;
      debug("reseed_done", { turn_index: state.turnIndex });
    }
  };

  const handlers: RoleHandlers = {
    heartbeat: () => ({ turn_active: false }),

    async onSessionOpen(payload, runtime) {
      rt = runtime;
      if (opened) {
        debug("session_open_duplicate_ignored");
        return;
      }
      opened = true;
      const scripted = isScripted(env);
      config = loadConfig({ appDir: payload.app_dir, configPath: payload.config_path, roles: ROLE_SETS.supervisor, requireKeys: !scripted, scripted, env });
      runtime.heartbeat.setInterval(config.config.ipc.heartbeat_s * 1000);
      runtime.ackTimeoutMs = config.config.ipc.ack_timeout_ms;
      sessionId = payload.session_id;
      workspace = payload.workspace;
      rules = loadRules(config.agentFolder, config.config.rule_block_max_chars);
      adapters = opts.adapters ?? { supervisor: await getAdapter(config.roles.supervisor.provider, { keys: config.keys, env }), memory: await getAdapter(config.roles.memory.provider, { keys: config.keys, env }) }; // harness-allow: U7 getAdapter()
      const gatePlug = opts.gatePlug ?? createPlug({ profile: config.config.harness.profile, denylist: config.config.supervisor.denylist, workspace, read_allowlist: config.config.harness.local.read_allowlist, protected_paths: config.config.harness.local.protected_paths, network_commands: config.config.harness.local.network_commands, approval: config.config.harness.local.approval, env });
      gate = new Gate(gatePlug);
      const plugHash = computePlugHash(config.config.harness.profile, config.config.supervisor.denylist);
      const modelRefs: Record<string, string> = { supervisor: config.roles.supervisor.modelId, memory: config.roles.memory.modelId };
      const dhash = computeDefinitionHash({ promptSystemHash: "", toolDefinitions: [], configSnapshot: configSnapshot(config), modelRefs, plugHash });
      const admitResult = admit(gatePlug, dhash, plugHash, 1);
      const admitPayload: PayloadOf<"admit_result"> = admitResult.admitted
        ? { status: "admitted", run_ctx: runCtxToWire(admitResult.run_ctx), exposure: admitResult.exposure }
        : { status: "refused", reason: admitResult.reason };
      runtime.send("admit_result", admitPayload);
      if (!admitResult.admitted) {
        void runtime.sendEvent({ ts: nowTs(), proc: "sup", type: "error", message: `admission refused: ${admitResult.reason}` }, false);
        return;
      }
      runtime.setRunCtx(runCtxToWire(admitResult.run_ctx));
      store = MemoryStore.open(join(config.dataDir, config.config.supervisor.memory_dir), workspaceHash(workspace), { gate, runCtx: runCtxToWire(admitResult.run_ctx), retentionDays: config.config.supervisor.memory_retention_days, secretPath: memorySecretPath(config.appDir) });
      state.memoriesLoaded = store.size;
      for (const w of store.warnings) debug("store_error", { op: "open", err: w.slice(0, 300) });
      const heartbeatMs = config.config.ipc.heartbeat_s * 1000;
      watchdog = new StallWatchdog(
        { stallTimeoutMs: config.config.supervisor.stall_timeout_s * 1000, heartbeatMs },
        {
          resume: (p) => runtime.send("resume", { reason: p.reason, phase: p.phase as "idle" }, "exec"),
          restartRequest: (reason) => runtime.send("restart_request", { reason }),
          intervention: (kind, text) => intervention(kind, text),
        },
        now,
      );
      reviewer = new Reviewer(review);
      triggers = new ReviewTriggers({ reviewEveryCalls: config.config.supervisor.review_every_calls, costAlertUsd: config.config.supervisor.cost_alert_usd }, (reason) => reviewer?.schedule(reason), (cost) => {
        debug("cost_alert", { turn_usd: cost, threshold_usd: config?.config.supervisor.cost_alert_usd });
        intervention("cost_alert", `turn cost $${cost.toFixed(4)} exceeds the alert threshold $${config?.config.supervisor.cost_alert_usd.toFixed(2)}`);
      });
      tickTimer = setInterval(() => {
        const action = watchdog?.tick();
        if (action !== undefined && action !== "none") debug("stall", { silent_s: Math.round((watchdog?.silentMs() ?? 0) / 1000), action });
      }, heartbeatMs);
      void reseed(payload.jsonl_path);
    },

    onMessage(msg) {
      switch (msg.type) {
        case "heartbeat":
          watchdog?.onHeartbeat(msg.payload);
          triggers?.onHeartbeat(msg.payload);
          return;
        case "event":
          onEventCopy(msg.payload as AgentEvent);
          return;
        case "prompt":
          void onPromptCopy(msg.payload);
          return;
        case "halt": {
          const haltReason = msg.payload.reason ?? "halted";
          gate!.halt(haltReason);
          const inFlight = gate!.collectInFlight() ?? [];
          runtime.send("halted", { reason: haltReason, in_flight: inFlight });
          return;
        }
        case "resolve":
          gate!.resolve(msg.payload.effect_id);
          return;
        default:
          return;
      }
    },

    async onShutdown() {
      if (tickTimer !== undefined) clearInterval(tickTimer);
      reviewer?.stop();
      const deadline = performance.now() + Math.max(500, (config?.config.ipc.shutdown_timeout_ms ?? 3000) - 500);
      while (inFlightModelCalls > 0 && performance.now() < deadline) await Bun.sleep(20);
    },
  };

  const runtime = new ChildRuntime("supervisor", epoch, handlers, opts.runtimeOptions ?? {});
  rt = runtime;
  return { runtime, state: () => (opened ? state : undefined), watchdog: () => watchdog };
}

function extractRequest(content: string): string {
  const m = /<user_request>\n([\s\S]*?)\n<\/user_request>/.exec(content);
  return m?.[1] ?? content;
}

