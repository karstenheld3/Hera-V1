// Executor role entry and message router (HERAV1EXEC-SP01; HERAV1EXEC-IP01 IS-01). The Executor has no frontend: it reads
// no stdin and writes no stdout (DD-09, IG-06); everything user-visible is an AgentEvent sent to the Communicator.

import { join } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { loadConfig, ROLE_SETS, type ResolvedConfig } from "../config/load.ts";
import { nowTs, type AgentEvent } from "../events.ts";
import { assembleSystemPrompt, workspaceTree } from "../prompt/assemble.ts";
import { loadPromptSystem, type PromptSystem } from "../prompt/loader.ts";
import { computeDefinitionHash, promptSystemContentHash } from "../harness/definition_hash.ts";
import { renderToolResult } from "./injection.ts";
import { ChildRuntime, assertSpawnedByCommunicator, type RoleHandlers } from "../process/child.ts";
import type { PayloadOf } from "../process/envelope.ts";
import { ROLE_NAMES, type Message } from "../models.ts";
import type { ProviderAdapter } from "../providers/base.ts";
import { getAdapter, isScripted } from "../providers/registry.ts";
import { projectSession } from "../session/projection.ts";
import { buildDefinitions, filterDefinitions } from "../tools/definitions.ts";
import { createToolRegistry } from "../tools/index.ts";
import type { ToolContext } from "../tools/registry.ts";
import { commandTableOf } from "../tools/shell.ts";
import { Agent, type AgentDeps } from "./agent.ts";
import { ChildRegistry, reapOrphans } from "./children.ts";
import { buildSessionStarted, configSnapshot, findGitRoot, resumeWarnings } from "./session.ts";
import { Gate } from "../harness/gate.ts";
import type { GateProvider } from "../harness/provider.ts";
import { admit, runCtxToWire } from "../harness/admit.ts";
import { createPlug, computePlugHash } from "../harness/plugs/factory.ts";

export interface ExecutorOptions {
  /** injected by tests: adapters, hooks, and the runtime transport */
  adapters?: { generating: ProviderAdapter; compacting: ProviderAdapter; websearch: ProviderAdapter };
  hooks?: AgentDeps["hooks"];
  runtimeOptions?: ConstructorParameters<typeof ChildRuntime>[3];
  env?: Record<string, string | undefined>;
  /** injected by tests: a custom gate plug (Scripted, PassThrough). Default: profile-based. */
  gatePlug?: GateProvider;
}

export interface ExecutorHandle {
  runtime: ChildRuntime;
  agent: () => Agent | undefined;
}

/** Builds the runtime and handlers; `start()` is left to the caller so tests can inject a transport first. */
export function createExecutor(epoch: number | undefined, opts: ExecutorOptions = {}): ExecutorHandle {
  const env = opts.env ?? process.env;
  let agent: Agent | undefined;
  let children: ChildRegistry | undefined;
  let toolCtxRef: ToolContext | undefined;
  let gate: Gate | undefined;
  let opened = false;

  const handlers: RoleHandlers = {
    heartbeat: () => agent?.heartbeat() ?? { turn_active: false, phase: "idle" },

    async onSessionOpen(payload, rt) {
      if (opened) {
        rt.send("debug_line", { ts: nowTs(), proc: "exec", dom: "exec", op: "session_open_duplicate_ignored" });
        return;
      }
      opened = true;
      const scripted = isScripted(env);
      const config: ResolvedConfig = loadConfig({ appDir: payload.app_dir, configPath: payload.config_path, roles: ROLE_SETS.executor, requireKeys: !scripted, scripted, env });
      rt.heartbeat.setInterval(config.config.ipc.heartbeat_s * 1000);
      rt.ackTimeoutMs = config.config.ipc.ack_timeout_ms;
      const promptSystem: PromptSystem = loadPromptSystem(config.agentFolder, { ruleBlockMaxChars: config.config.rule_block_max_chars });
      const notices: string[] = promptSystem.warnings.map((w) => (w.startsWith("NOTICE:") || w.startsWith("WARNING:") ? w : `WARNING: ${w}`));
      const promptHash = promptSystemContentHash(promptSystem);
      const tools = buildDefinitions({ os: process.platform === "win32" ? "windows" : process.platform, shell: process.platform === "win32" ? "pwsh" : "sh", skills: promptSystem.skills });
      const adapters = opts.adapters ?? {
        generating: await getAdapter(config.roles.generating.provider, { keys: config.keys, env }),
        compacting: await getAdapter(config.roles.compacting.provider, { keys: config.keys, env }),
        websearch: await getAdapter(config.roles.websearch.provider, { keys: config.keys, env }),
      };
      children = new ChildRegistry(() => rt.heartbeat.beatNow());
      const toolCtx: ToolContext = {
        workspace: payload.workspace,
        appDir: payload.app_dir,
        limits: { toolResultMaxChars: config.config.tool_result_max_chars },
        promptSystem,
        askUser: () => Promise.reject(new Error("agent not ready")),
        children,
        adapters: { websearch: adapters.websearch, websearchRole: config.roles.websearch },
        sessions: { dir: join(config.dataDir, "sessions") },
        state: { todo: [] },
        signal: new AbortController().signal,
      };
      toolCtxRef = toolCtx;
      const snapshot = configSnapshot(config);
      const plugHash = computePlugHash(config.config.harness.profile, config.config.supervisor.denylist);
      const modelRefs: Record<string, string> = {};
      for (const r of ROLE_NAMES) modelRefs[r] = config.roles[r].modelId;
      modelRefs["websearch"] = config.roles.websearch.modelId;
      const dhash = computeDefinitionHash({ promptSystemHash: promptHash, toolDefinitions: tools, configSnapshot: snapshot, modelRefs, plugHash });
      let systemPrompt: string;
      let messages: Message[] = [];
      let todoJson: string | undefined;
      if (payload.mode === "resume") {
        const projection = projectSession(payload.jsonl_path);
        if (projection.header !== undefined) systemPrompt = projection.header.systemPrompt;
        else systemPrompt = assembleSystemPrompt(promptSystem, workspaceInfo(payload.workspace, config.agentFolder, config));
        messages = projection.messages;
        todoJson = projection.todoJson;
        if (projection.todo !== undefined) toolCtx.state.todo = projection.todo;
        notices.push(...resumeWarnings(projection, { definition_hash: dhash }));
        // H-08 restart rule: close open descriptors as unknown, tell the model, never re-dispatch
        if (projection.openToolCalls.length > 0) {
          const toolNames = new Map<string, string>();
          for (const e of projection.events) {
            if (e.type === "tool_call_requested") toolNames.set(e.id, e.tool);
          }
          for (const id of projection.openToolCalls) {
            const toolName = toolNames.get(id) ?? "unknown";
            const unknownText = `[unknown] The effect '${toolName}' was requested but the process crashed before completion. The outcome is indeterminate - the effect may or may not have happened. Do not re-issue this operation under the same or a new descriptor unless you can establish the effect did not happen.`;
            const finishedEvent: AgentEvent = { ts: nowTs(), proc: "exec", type: "tool_call_finished", id, status: "unknown", result: unknownText, result_chars: unknownText.length };
            void rt.sendEvent(finishedEvent, false);
            messages.push({ role: "tool", content: renderToolResult(unknownText, toolName, id), toolCallId: id, origin: { kind: "tool", ref: id } });
          }
          notices.push(`WARNING: ${projection.openToolCalls.length} tool call${projection.openToolCalls.length === 1 ? "" : "s"} from the previous session closed as unknown (crash recovery). The model has been informed; the operation${projection.openToolCalls.length === 1 ? " was" : "s were"} not re-dispatched.`);
        }
      } else {
        systemPrompt = assembleSystemPrompt(promptSystem, workspaceInfo(payload.workspace, config.agentFolder, config));
      }
      const gatePlug = opts.gatePlug ?? createPlug({ profile: config.config.harness.profile, denylist: config.config.supervisor.denylist, workspace: payload.workspace, read_allowlist: config.config.harness.local.read_allowlist, protected_paths: config.config.harness.local.protected_paths, network_commands: config.config.harness.local.network_commands, approval: config.config.harness.local.approval, env });
      gate = new Gate(gatePlug);
      toolCtx.gate = gate;
      const admitResult = admit(gatePlug, dhash, plugHash, 1);
      const admitPayload: PayloadOf<"admit_result"> = admitResult.admitted
        ? { status: "admitted", run_ctx: runCtxToWire(admitResult.run_ctx), exposure: admitResult.exposure }
        : { status: "refused", reason: admitResult.reason };
      rt.send("admit_result", admitPayload);
      if (!admitResult.admitted) {
        void rt.sendEvent({ ts: nowTs(), proc: "exec", type: "error", message: `admission refused: ${admitResult.reason}` }, false);
        return;
      }
      rt.setRunCtx(runCtxToWire(admitResult.run_ctx));
      toolCtx.runCtx = runCtxToWire(admitResult.run_ctx);
      const exposedTools = filterDefinitions(tools, admitResult.exposure);
      const registry = createToolRegistry(exposedTools);
      agent = new Agent({ runtime: rt, config, adapters, promptSystem, systemPrompt, tools: exposedTools, registry, toolCtx, children, workspace: payload.workspace, gate, hooks: opts.hooks ?? testHooks(env) });
      agent.messages = messages;
      agent.todoJson = todoJson;
      if (payload.mode === "new") {
        await rt.sendEvent(buildSessionStarted(systemPrompt, exposedTools, snapshot, dhash, config.config.harness.profile), true);
      }
      for (const n of notices) {
        const severity = n.startsWith("WARNING:") ? "warning" : n.startsWith("NOTICE:") ? "notice" : "error";
        void rt.sendEvent({ ts: nowTs(), proc: "exec", type: "error", message: n, severity }, false);
      }
      if (payload.orphans !== undefined && payload.orphans.length > 0) {
        const reaped = reapOrphans(payload.orphans);
        if (reaped.length > 0) void rt.sendEvent({ ts: nowTs(), proc: "exec", type: "error", message: `NOTICE: reaped ${reaped.length} orphan tool process${reaped.length === 1 ? "" : "es"} from the previous Executor: ${reaped.join(", ")}`, category: "process", severity: "notice" }, false);
      }
    },

    onMessage(msg, rt) {
      if (agent === undefined) return;
      switch (msg.type) {
        case "prompt":
          rt.setPromptId(String(msg.id));
          void agent.runTurn(msg.payload);
          return;
        case "cancel":
          void agent.onCancel("cancel");
          return;
        case "continue":
          agent.onContinue(msg.payload);
          return;
        case "answer":
          agent.onAnswer(msg.payload);
          return;
        case "inject":
          agent.onInject(msg.payload);
          return;
        case "resume":
          void agent.onResume(msg.payload);
          return;
        case "halt": {
          const haltReason = msg.payload.reason ?? "halted";
          gate?.halt(haltReason);
          const inFlight = gate?.collectInFlight() ?? [];
          void agent.onCancel("cancel");
          rt.send("halted", { reason: haltReason, in_flight: inFlight });
          return;
        }
        case "resolve":
          gate?.resolve(msg.payload.effect_id, msg.payload.decision);
          void rt.sendEvent({ ts: nowTs(), proc: "exec", type: "effect_resolved", effect_id: msg.payload.effect_id, decision: msg.payload.decision ?? "deny" }, false);
          return;
        default:
          return;
      }
    },

    async onShutdown(reason) {
      if (agent !== undefined) await agent.onCancel("shutdown");
      if (children !== undefined) await children.terminateAll(reason === "disconnect" ? 300 : 1000);
      if (toolCtxRef !== undefined) await commandTableOf(toolCtxRef).terminateAll();
    },
  };

  const runtime = new ChildRuntime("executor", epoch, handlers, opts.runtimeOptions ?? {});
  return { runtime, agent: () => agent };
}

function workspaceInfo(workspace: string, _agentFolder: string, config: ResolvedConfig): Parameters<typeof assembleSystemPrompt>[1] {
  return { os: process.platform === "win32" ? "windows" : process.platform, workspace, gitRoot: findGitRoot(workspace), tree: workspaceTree(workspace, { maxDepth: config.config.workspace_tree_max_depth, maxLines: config.config.workspace_tree_max_lines }) };
}


/**
 * Test hook (HERAV1SUPV-TP01 stall tests): HERA_TEST_FREEZE_MS blocks the Executor's event loop once, before the
 * first model call, so no heartbeat and no event leave the process - the Supervisor's stall condition A.
 */
function testHooks(env: Record<string, string | undefined>): AgentDeps["hooks"] {
  const freeze = Number(env["HERA_TEST_FREEZE_MS"] ?? "");
  if (!Number.isFinite(freeze) || freeze <= 0) return undefined;
  let used = false;
  return {
    beforeModelCall: () => {
      if (!used) {
        used = true;
        Bun.sleepSync(freeze);
      }
      return Promise.resolve();
    },
  };
}

export async function executorMain(args: ParsedArgs): Promise<number> {
  assertSpawnedByCommunicator("executor");
  const { runtime } = createExecutor(args.epoch);
  runtime.start();
  await new Promise<never>(() => {});
  return 0;
}

export type { PayloadOf };
