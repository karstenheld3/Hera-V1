// Executor turn loop (HERAV1EXEC-SP01 FR-01..FR-04, FR-06..FR-08; HERAV1EXEC-IP01 IS-03, IS-04). Port of V1 agent.py
// run_turn without the safety gate: two-gate dispatch (acknowledgement, then Supervisor verdict) before every tool,
// coalesced deltas, cancellation and stall resume, compaction after each model call, ask_user round trips.

import type { ResolvedConfig } from "../config/load.ts";
import { computeCost, priceFor } from "../cost.ts";
import { dlog } from "../debug/debuglog.ts";
import { HeraError, ProviderError, type ErrorCategory } from "../errors.ts";
import { nowTs, type AgentEvent, type ErrorSeverity } from "../events.ts";
import type { Message, StopReason, ThinkingBlock, ToolCall, ToolDefinition, Usage } from "../models.ts";
import { findWorkflow, type PromptSystem } from "../prompt/loader.ts";
import type { ChildRuntime } from "../process/child.ts";
import type { PayloadOf } from "../process/envelope.ts";
import type { AdapterDelta, ProviderAdapter } from "../providers/base.ts";
import { egressModelInvoke } from "../providers/registry.ts";
import type { AskUserAnswer, AskUserRequest, ToolContext, ToolRegistry } from "../tools/registry.ts";
import type { ChildRegistry } from "./children.ts";
import { compact, compactionThreshold, dropOldToolResults, estimateRequestSize, fitsWindow, KEEP_TAIL_MESSAGES, projectFromMessages, shouldCompact } from "./compaction.ts";
import { InjectMailbox, appendNoteToToolResult, buildUserMessage, renderToolResult } from "./injection.ts";
import type { Gate } from "../harness/gate.ts";
import { EffectDescriptor, type EffectKind } from "../harness/descriptor.ts";

export type Phase = "idle" | "model_call" | "tool_call" | "waiting_answer" | "compacting";

export interface TurnUsage {
  uncached_input: number;
  cache_write: number;
  cache_read: number;
  output: number;
  cost_usd: number;
}

export interface AgentDeps {
  runtime: ChildRuntime;
  config: ResolvedConfig;
  adapters: { generating: ProviderAdapter; compacting: ProviderAdapter };
  promptSystem: PromptSystem;
  systemPrompt: string;
  tools: ToolDefinition[];
  registry: ToolRegistry;
  toolCtx: ToolContext;
  children: ChildRegistry;
  workspace: string;
  /** the gate socket - one per process (D-13) */
  gate: Gate;
  /** injected clock for the user metadata date (tests) */
  now?: () => Date;
  /** test hook: freeze the loop before the model call (stall tests) */
  hooks?: { beforeModelCall?(): Promise<void>; beforeTool?(call: ToolCall): Promise<void> };
}

export const CANCEL_NOTE = (n: number): string => `turn cancelled after ${n} tool call${n === 1 ? "" : "s"}`;
export const RESUME_NOTE = "turn resumed by supervisor after stall";
export const COALESCE_MS = 50;
export const COALESCE_CHARS = 512;

/** Buffers text/thinking deltas: one event per 50 ms or 512 chars, always flushed before any other event (RV01-RF-14). */
export class DeltaCoalescer {
  private text = "";
  private thinking = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly emit: (event: AgentEvent) => void) {}

  push(kind: "text" | "thinking", chunk: string): void {
    if (kind === "text") this.text += chunk;
    else this.thinking += chunk;
    if (this.text.length >= COALESCE_CHARS || this.thinking.length >= COALESCE_CHARS) {
      this.flush();
      return;
    }
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), COALESCE_MS);
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.thinking.length > 0) {
      this.emit({ ts: nowTs(), proc: "exec", type: "thinking_delta", text: this.thinking });
      this.thinking = "";
    }
    if (this.text.length > 0) {
      this.emit({ ts: nowTs(), proc: "exec", type: "text_delta", text: this.text });
      this.text = "";
    }
  }
}

type AbortReason = "cancel" | "resume_frozen" | "resume_tool_hang" | "shutdown";

interface PendingAsk {
  requestId: string;
  kind: "question" | "continue";
  resolve(answer: AskUserAnswer | boolean): void;
  reject(error: Error): void;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (dp[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) (dp[i] as number[])[j] = Math.min((dp[i - 1] as number[])[j]! + 1, (dp[i] as number[])[j - 1]! + 1, (dp[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return (dp[a.length] as number[])[b.length] as number;
}

/** FR-03: `/name` → slash-command workflow wrapping; unknown → the three closest names. */
export function expandSlashCommand(input: string, system: PromptSystem): { content: string; workflow?: string } | { unknown: string; suggestions: string[] } {
  const stripped = input.trim();
  if (!stripped.startsWith("/")) return { content: input };
  const name = (stripped.split(/\s+/)[0] as string).slice(1);
  const workflow = findWorkflow(system, name);
  if (workflow === undefined) {
    const names = system.workflows.map((w) => w.name);
    const prefixed = names.filter((n) => n.startsWith(name));
    const close = names
      .filter((n) => !prefixed.includes(n))
      .map((n) => ({ n, d: levenshtein(name, n) }))
      .filter((x) => x.d <= Math.max(2, Math.floor(name.length / 2)))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.n);
    return { unknown: name, suggestions: [...prefixed, ...close].slice(0, 3) };
  }
  return { content: `${stripped}\n<workflows>\n@[/${workflow.name}] is a [Workflow]:\n<workflow>\nThe user mentioned the (${workflow.name}) workflow. Here are its contents:\n${workflow.content}\n</workflow>\n</workflows>`, workflow: workflow.name };
}

export class Agent {
  messages: Message[] = [];
  todoJson: string | undefined;
  phase: Phase = "idle";
  phaseSince = nowTs();
  turnActive = false;
  turnUsage: TurnUsage = { uncached_input: 0, cache_write: 0, cache_read: 0, output: 0, cost_usd: 0 };
  readonly mailbox = new InjectMailbox();
  toolCallsThisTurn = 0;
  private turnIndex = 0;
  private abort: AbortController | undefined;
  private abortReason: AbortReason | undefined;
  private pendingAsk: PendingAsk | undefined;
  private readonly executing = new Set<string>();
  private askCounter = 0;
  private toolCallCounter = 0;
  private turnCacheWrite = 0;
  private finishing = false;
  private queuedPrompt: PayloadOf<"prompt"> | undefined;
  private ledgerNoticeSent = false;
  private currentToolStart = 0;
  private lastRequestedCall: ToolCall | undefined;
  private effectIdCounter = 0;
  private turnStartMs = 0;
  private promptId = "";
  private readonly coalescer: DeltaCoalescer;

  constructor(private readonly deps: AgentDeps) {
    this.coalescer = new DeltaCoalescer((e) => void this.deps.runtime.sendEvent(e, false));
    deps.toolCtx.askUser = (req) => this.askUser("question", req);
  }

  // ------------------------------------------------------------------ heartbeat

  heartbeat(): Partial<PayloadOf<"heartbeat">> {
    return {
      turn_active: this.turnActive,
      phase: this.phase,
      phase_since: this.phaseSince,
      turn_usage: {
        ...this.turnUsage,
        effects: this.toolCallsThisTurn,
        wall_time: this.turnActive ? (Date.now() - this.turnStartMs) / 1000 : 0,
      },
      children: this.deps.children.list(),
    };
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseSince = nowTs();
  }

  private emit(event: AgentEvent, awaitAck = false): Promise<void> {
    this.coalescer.flush();
    return this.deps.runtime.sendEvent(event, awaitAck);
  }

  private errorEvent(message: string, category?: ErrorCategory, severity?: ErrorSeverity): AgentEvent {
    const base: { ts: string; proc: "exec"; type: "error"; message: string } = { ts: nowTs(), proc: "exec", type: "error", message };
    const out: Record<string, unknown> = { ...base };
    if (severity !== undefined) out.severity = severity;
    if (category !== undefined) out.category = category;
    return out as AgentEvent;
  }

  private debug(op: string, fields: Record<string, unknown> = {}, dom = "exec"): void {
    dlog(dom, op, fields);
  }

  private cost(usage: Usage, roleName: "generating" | "compacting"): number | undefined {
    const role = this.deps.config.roles[roleName];
    return computeCost(usage, priceFor(this.deps.config.pricing, role.provider, role.modelId));
  }

  // ------------------------------------------------------------------ turn

  async runTurn(prompt: PayloadOf<"prompt">): Promise<void> {
    if (this.turnActive) {
      // the Communicator sends the next prompt right after turn_finished; its ack may still be in flight here
      if (this.finishing && this.queuedPrompt === undefined) {
        this.queuedPrompt = prompt;
        return;
      }
      await this.emit(this.errorEvent("prompt received while a turn is active -> ignored (the Communicator queues prompts).", undefined, "warning"));
      return;
    }
    this.turnActive = true;
    this.turnStartMs = Date.now();
    this.turnIndex++;
    this.promptId = `prompt_${this.turnIndex}`;
    this.mailbox.setPromptContext(this.promptId, this.deps.gate.run_ctx);
    this.toolCallsThisTurn = 0;
    this.turnUsage = { uncached_input: 0, cache_write: 0, cache_read: 0, output: 0, cost_usd: 0 };
    this.turnCacheWrite = 0;
    this.abortReason = undefined;
    try {
      if (prompt.note !== undefined) await this.emit({ ts: nowTs(), proc: "exec", type: "executor_resumed", reason: "restart" });
      if (prompt.text.trim().length === 0) {
        await this.emit(this.errorEvent("empty prompt -> nothing sent to the model.", undefined, "error"));
        await this.finish("end", []);
        return;
      }
      const expanded = expandSlashCommand(prompt.text, this.deps.promptSystem);
      if ("unknown" in expanded) {
        const hint = expanded.suggestions.length > 0 ? ` Closest matches: ${expanded.suggestions.map((s) => `/${s}`).join(", ")}` : "";
        await this.emit(this.errorEvent(`Unknown workflow '/${expanded.unknown}'.${hint}`, undefined, "error"));
        await this.finish("end", []);
        return;
      }
      const drained = this.mailbox.drainForUserMessage();
      const now = (this.deps.now ?? (() => new Date()))();
      const content = buildUserMessage(expanded.content, drained.blocks, { date: nowTsOf(now), cwd: this.deps.workspace });
      const userEvent: AgentEvent = expanded.workflow !== undefined ? { ts: nowTs(), proc: "exec", type: "user_message", content, expanded_workflow: expanded.workflow, prompt_id: this.promptId } : { ts: nowTs(), proc: "exec", type: "user_message", content, prompt_id: this.promptId };
      await this.emit(userEvent, true);
      if (drained.memoryIds.length > 0) await this.emit({ ts: nowTs(), proc: "exec", type: "memory_injected", memory_ids: drained.memoryIds, bytes: drained.memoryBytes, prompt_id: this.promptId });
      this.messages.push({ role: "user", content, origin: { kind: "user", ref: this.promptId } });
      await this.emit({ ts: nowTs(), proc: "exec", type: "turn_started", role: "generating", prompt_id: this.promptId });
      await this.loop();
    } catch (error) {
      if (this.turnActive) {
        await this.emit(this.errorEvent(`turn failed -> ${error instanceof Error ? error.message : String(error)}`, error instanceof HeraError ? error.category : undefined, "error"));
        this.turnActive = false;
        this.setPhase("idle");
        this.mailbox.discardLate(this.debug.bind(this));
      }
    }
  }

  private async loop(): Promise<void> {
    let pauses = 0;
    let resumeReissues = 0;
    for (;;) {
      const fit = await this.checkFit();
      if (fit !== "ok") {
        await this.emit(this.errorEvent(`request exceeds the model's context window (${fit} tokens estimated). Dropping oldest tool results and ending the turn.`, undefined, "warning"));
        await this.finish("end", []);
        return;
      }
      const call = await this.modelCall();
      if (call.kind === "provider_error") {
        await this.emit(this.errorEvent(call.message, "provider", "error"));
        this.turnActive = false;
        this.setPhase("idle");
        this.mailbox.discardLate(this.debug.bind(this));
        return; // no turn_finished (EC-02)
      }
      if (call.kind === "aborted") {
        if (this.abortReason === "resume_frozen" && resumeReissues === 0) {
          resumeReissues++;
          this.abortReason = undefined;
          this.messages.push({ role: "user", content: `<supervisor_note>\n${RESUME_NOTE}\n</supervisor_note>`, origin: { kind: "system", ref: "supervisor" } });
          await this.emit({ ts: nowTs(), proc: "exec", type: "executor_resumed", reason: "frozen" });
          continue;
        }
        await this.finish("cancelled", []);
        return;
      }
      const { assistant, stopReason, thinking } = call;
      this.messages.push(assistant);
      await this.maybeCompact();
      if (stopReason === "refusal") {
        await this.emit(this.errorEvent(`the model refused to continue: ${assistant.content.slice(0, 500)}`, undefined, "error"));
        await this.finish("refusal", thinking);
        return;
      }
      if (stopReason === "max_output") {
        await this.emit(this.errorEvent("the model hit its output limit -> the response may be incomplete.", undefined, "warning"));
        await this.finish("max_output", thinking);
        return;
      }
      if (stopReason === "pause") {
        if (pauses === 0) {
          pauses++;
          continue;
        }
        await this.finish("end", thinking);
        return;
      }
      const calls = assistant.toolCalls ?? [];
      if (calls.length === 0) {
        await this.finish("end", thinking);
        return;
      }
      for (const toolCall of calls) {
        if (this.turnAborted()) break;
        if (this.toolCallsThisTurn >= this.deps.config.config.max_tool_calls_per_prompt) {
          if (this.deps.config.config.auto_continue) this.toolCallsThisTurn = 0;
          else {
            const proceed = await this.askContinue();
            if (proceed === "cancelled") break;
            if (!proceed) {
              await this.emit(this.errorEvent(`tool call limit (${this.deps.config.config.max_tool_calls_per_prompt}) reached and the user declined to continue.`, "limit", "error"));
              await this.finish("end", thinking);
              return;
            }
            this.toolCallsThisTurn = 0;
          }
        }
        await this.executeTool(toolCall);
        if (this.turnAborted()) break;
      }
      if (this.turnAborted()) {
        await this.finish("cancelled", thinking);
        return;
      }
    }
  }

  private async modelCall(): Promise<{ kind: "ok"; assistant: Message; stopReason: StopReason; thinking: ThinkingBlock[] } | { kind: "aborted" } | { kind: "provider_error"; message: string }> {
    this.setPhase("model_call");
    if (this.deps.hooks?.beforeModelCall !== undefined) await this.deps.hooks.beforeModelCall();
    const controller = new AbortController();
    this.abort = controller;
    let content = "";
    const toolCalls: ToolCall[] = [];
    let usage: Usage = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    let stopReason: StopReason = "end";
    let thinking: ThinkingBlock[] = [];
    const role = this.deps.config.roles.generating;
    const callStarted = performance.now();
    let firstTokenAt: number | undefined;
    dlog("llm", "request", { role: "generating", provider: role.provider, model: role.modelId, msgs: this.messages.length, tools: this.deps.tools.length });
    try {
      const stream = egressModelInvoke(this.deps.adapters.generating, this.deps.gate, { system: this.deps.systemPrompt, tools: this.deps.tools, messages: this.messages, role }, controller.signal, (event, awaitAck) => this.emit(event, awaitAck ?? false));
      for await (const delta of stream as AsyncIterable<AdapterDelta>) {
        if (firstTokenAt === undefined && (delta.kind === "text" || delta.kind === "thinking" || delta.kind === "tool_call")) {
          firstTokenAt = performance.now();
          dlog("llm", "first_token", { role: "generating", dur_ms: Math.round(firstTokenAt - callStarted) });
        }
        switch (delta.kind) {
          case "text":
            content += delta.text;
            this.coalescer.push("text", delta.text);
            break;
          case "thinking":
            this.coalescer.push("thinking", delta.text);
            break;
          case "tool_call":
            toolCalls.push(delta.toolCall);
            break;
          case "notice":
            dlog("llm", "retry", { role: "generating", err: delta.text.slice(0, 300) });
            await this.emit(this.errorEvent(delta.text, undefined, "notice"));
            break;
          case "usage":
            usage = delta.usage;
            stopReason = delta.stopReason;
            thinking = delta.thinkingPayloads;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      this.coalescer.flush();
      if (controller.signal.aborted) return { kind: "aborted" };
      dlog("llm", "error", { role: "generating", dur_ms: Math.round(performance.now() - callStarted), err: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      if (error instanceof ProviderError) return { kind: "provider_error", message: error.message };
      return { kind: "provider_error", message: `${error instanceof Error ? error.message : String(error)}` };
    } finally {
      this.abort = undefined;
    }
    this.coalescer.flush();
    if (controller.signal.aborted || stopReason === "cancelled") return { kind: "aborted" };
    const cost = this.cost(usage, "generating");
    dlog("llm", "response", { role: "generating", dur_ms: Math.round(performance.now() - callStarted), in_tok: usage.uncachedInput, cache_read: usage.cacheRead, cache_write: usage.cacheWrite, out_tok: usage.output, cost_usd: cost ?? null, tool_calls: toolCalls.length, stop: stopReason });
    this.turnCacheWrite += usage.cacheWrite;
    this.turnUsage = { uncached_input: this.turnUsage.uncached_input + usage.uncachedInput, cache_write: this.turnUsage.cache_write + usage.cacheWrite, cache_read: this.turnUsage.cache_read + usage.cacheRead, output: this.turnUsage.output + usage.output, cost_usd: Math.round((this.turnUsage.cost_usd + (cost ?? 0)) * 1e6) / 1e6 };
    const assistant: Message = { role: "assistant", content, toolCalls, thinking, usage, origin: { kind: "model", ref: this.promptId } };
    return { kind: "ok", assistant, stopReason, thinking };
  }

  /** cancel or shutdown ends the turn; a stall resume does not (kept as a method so control-flow narrowing does not apply) */
  private turnAborted(): boolean {
    return this.abortReason === "cancel" || this.abortReason === "shutdown";
  }

  /** Pre-call fit check (FR-04): estimates the complete outgoing request; if over max_input, compacts then drops oldest tool results; returns "ok" or the estimated token count as a string. */
  private async checkFit(): Promise<"ok" | string> {
    const cfg = this.deps.config;
    const maxInput = cfg.roles.generating.maxInput ?? cfg.roles.generating.contextWindow ?? 128000;
    let estimated = estimateRequestSize(this.deps.systemPrompt, this.deps.tools, this.messages);
    if (fitsWindow(estimated, maxInput)) return "ok";
    dlog("app", "fit_check_over", { estimated, maxInput });
    await this.maybeCompact();
    estimated = estimateRequestSize(this.deps.systemPrompt, this.deps.tools, this.messages);
    if (fitsWindow(estimated, maxInput)) return "ok";
    const { messages: trimmed, dropped } = dropOldToolResults(this.messages, KEEP_TAIL_MESSAGES);
    if (dropped > 0) {
      this.messages = trimmed;
      dlog("app", "fit_check_dropped", { dropped, remaining: this.messages.length });
      estimated = estimateRequestSize(this.deps.systemPrompt, this.deps.tools, this.messages);
      if (fitsWindow(estimated, maxInput)) return "ok";
    }
    return String(estimated);
  }

  private async maybeCompact(): Promise<void> {
    const cfg = this.deps.config;
    const threshold = compactionThreshold(cfg.config.compaction_threshold_fraction, cfg.config.compaction_threshold_max_tokens, cfg.roles.generating);
    const projected = projectFromMessages(this.messages);
    if (!shouldCompact(projected, threshold)) return;
    dlog("app", "compaction_start", { projected, threshold });
    await this.emit(this.errorEvent(`Compacting context (~${projected} tokens, threshold ${threshold})...`, undefined, "notice"));
    this.setPhase("compacting");
    const compactStarted = performance.now();
    try {
      const outcome = await compact(this.messages, cfg.roles.compacting, this.deps.adapters.compacting, this.todoJson, this.deps.gate, undefined, (event, awaitAck) => this.emit(event, awaitAck ?? false));
      this.messages = outcome.messages;
      dlog("llm", "response", { role: "compacting", provider: cfg.roles.compacting.provider, model: cfg.roles.compacting.modelId, dur_ms: Math.round(performance.now() - compactStarted), in_tok: outcome.usage.uncachedInput, cache_read: outcome.usage.cacheRead, out_tok: outcome.usage.output, cost_usd: this.cost(outcome.usage, "compacting") ?? null, tool_calls: 0 });
      dlog("app", "compaction", { truncated: outcome.truncated, kept: outcome.kept, checkpoint_chars: outcome.checkpointText.length });
      await this.emit({ ts: nowTs(), proc: "exec", type: "checkpoint_created", text: outcome.checkpointText, truncated_messages: outcome.truncated, kept_messages: outcome.kept, prompt_id: this.promptId, usage: { uncached_input: outcome.usage.uncachedInput, cache_write: outcome.usage.cacheWrite, cache_read: outcome.usage.cacheRead, output: outcome.usage.output, cost_usd: this.cost(outcome.usage, "compacting") ?? null } });
    } catch (error) {
      dlog("app", "compaction_failed", { err: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      await this.emit(this.errorEvent(`compaction failed (${error instanceof Error ? error.message : String(error)}). Continuing uncompacted - the next turn may be expensive.`, undefined, "warning"));
    }
  }

  // ------------------------------------------------------------------ tools (gate socket)

  private async executeTool(call: ToolCall): Promise<void> {
    this.toolCallsThisTurn++;
    this.toolCallCounter++;
    this.lastRequestedCall = call;
    if (this.deps.hooks?.beforeTool !== undefined) await this.deps.hooks.beforeTool(call);
    // gate 1: the request line is on disk
    await this.emit({ ts: nowTs(), proc: "exec", type: "tool_call_requested", id: call.id, tool: call.name, args: call.args ?? {}, args_json: call.argsJson, prompt_id: this.promptId }, true);
    dlog("tool", "start", { tool: call.name, args: summarizeToolArgs(call.args ?? {}) });
    const toolStarted = performance.now();
    // gate 2: the gate socket (single chokepoint, FR-01)
    const descriptor = new EffectDescriptor({
      effect_id: `fx_${++this.effectIdCounter}`,
      kind: "tool.invoke" as EffectKind,
      target: call.name,
      parameters: call.args ?? {},
      origin_refs: [this.promptId],
      prompt_id: this.promptId,
      run_ctx: this.deps.gate.run_ctx,
    });
    const gateResult = await this.deps.gate.execute(descriptor, {
      dispatch: async () => {
        if (this.turnAborted()) {
          return { status: "cancelled" as const, text: "cancelled before execution" };
        }
        this.setPhase("tool_call");
        this.currentToolStart = performance.now();
        const controller = new AbortController();
        this.abort = controller;
        this.deps.toolCtx.signal = controller.signal;
        this.executing.add(call.id);
        try {
          const r = await this.deps.registry.dispatch(call, this.deps.toolCtx);
          return { status: r.status, text: r.text };
        } finally {
          this.executing.delete(call.id);
          this.abort = undefined;
        }
      },
      onUnavailable: async (effect_id) => {
        await this.emit(this.errorEvent(`gate unavailable for effect ${effect_id}`, undefined, "warning"));
      },
      onPending: async (effect_id) => {
        const tool = call.name;
        const commandLine = typeof call.args?.["CommandLine"] === "string" ? call.args["CommandLine"] : "";
        const cwd = typeof call.args?.["Cwd"] === "string" ? call.args["Cwd"] : "";
        const summaryParts: string[] = [];
        if (commandLine.length > 0) summaryParts.push(commandLine.slice(0, 200));
        if (cwd.length > 0) summaryParts.push(`Cwd: ${cwd}`);
        const summary = summaryParts.length > 0 ? summaryParts.join(" | ") : tool;
        const reason = "pending: awaiting user decision";
        await this.emit({ ts: nowTs(), proc: "exec", type: "effect_pending", effect_id, tool, reason, prompt_id: this.promptId });
        this.deps.runtime.send("ask_user", { kind: "pending", request_id: `pending_${effect_id}`, effect_id, tool, summary, reason });
      },
    });
    dlog("tool", "gate", { tool: call.name, result: gateResult.status, end_prompt: gateResult.end_prompt });
    let result: { status: "ok" | "error" | "timed_out" | "cancelled" | "blocked"; text: string } = gateResult;
    if (gateResult.end_prompt) {
      // unavailable: the running prompt ends with zero effects
      call.status = result.status;
      call.result = result.text;
      await this.emit({ ts: nowTs(), proc: "exec", type: "tool_call_finished", id: call.id, status: result.status, result: result.text, result_chars: result.text.length, prompt_id: this.promptId });
      this.messages.push({ role: "tool", content: renderToolResult(result.text, call.name, call.id), toolCallId: call.id, origin: { kind: "tool", ref: call.id } });
      return;
    }
    if (result.status === "ok" || result.status === "error" || result.status === "timed_out" || result.status === "cancelled") {
      if (this.abortReason === "resume_tool_hang") {
        const seconds = Math.round((performance.now() - this.currentToolStart) / 1000);
        result = { status: "timed_out", text: `tool terminated by supervisor after ${seconds} s without completion` };
        this.abortReason = undefined;
        await this.emit({ ts: nowTs(), proc: "exec", type: "executor_resumed", reason: "tool_hang" });
      } else if (this.turnAborted()) {
        result = { status: "cancelled", text: result.text.length > 0 ? result.text : "cancelled" };
      }
      if (call.name === "todo_list" && result.status === "ok") this.todoJson = result.text;
      if (!this.ledgerNoticeSent && result.status === "error" && /was not read in this session/.test(result.text)) {
        this.ledgerNoticeSent = true;
        await this.emit(this.errorEvent("the read ledger starts empty in this Executor lifetime -> files edited before a restart need one read_file first.", undefined, "notice"));
      }
    }
    dlog("tool", "end", { tool: call.name, dur_ms: Math.round(performance.now() - toolStarted), status: result.status, chars: result.text.length, ...(result.status === "error" ? { err: result.text.slice(0, 300) } : {}) });
    call.status = result.status;
    call.result = result.text;
    const injected = this.mailbox.drainForToolResult();
    const content = injected.note !== undefined ? appendNoteToToolResult(result.text, injected.note) : result.text;
    const finished: AgentEvent = { ts: nowTs(), proc: "exec", type: "tool_call_finished", id: call.id, status: result.status, result: result.text, result_chars: result.text.length, prompt_id: this.promptId, ...(injected.note !== undefined ? { injected_note: injected.note } : {}) };
    await this.emit(finished);
    if (injected.memoryIds.length > 0) await this.emit({ ts: nowTs(), proc: "exec", type: "memory_injected", memory_ids: injected.memoryIds, bytes: injected.memoryBytes, prompt_id: this.promptId });
    this.messages.push({ role: "tool", content: renderToolResult(content, call.name, call.id), toolCallId: call.id, origin: { kind: "tool", ref: call.id } });
  }

  // ------------------------------------------------------------------ ask_user round trips (FR-08, DD-10)

  private askUser(kind: "question", req: AskUserRequest): Promise<AskUserAnswer>;
  private askUser(kind: "continue", req: undefined): Promise<boolean>;
  private askUser(kind: "question" | "continue", req: AskUserRequest | undefined): Promise<AskUserAnswer | boolean> {
    const requestId = `ask_${++this.askCounter}`;
    const previous = this.phase;
    const askStarted = performance.now();
    this.setPhase("waiting_answer");
    return new Promise<AskUserAnswer | boolean>((resolve, reject) => {
      this.pendingAsk = { requestId, kind, resolve, reject };
      const payload: PayloadOf<"ask_user"> = kind === "question" && req !== undefined ? { kind, request_id: requestId, question: req.question, options: req.options, allow_multiple: req.allowMultiple } : { kind: "continue", request_id: requestId, detail: `Tool call limit (${this.deps.config.config.max_tool_calls_per_prompt}) reached.` };
      this.deps.runtime.send("ask_user", payload);
    }).finally(() => {
      this.pendingAsk = undefined;
      dlog("tool", "ask_user", { kind, wait_ms: Math.round(performance.now() - askStarted) });
      if (this.phase === "waiting_answer") this.setPhase(previous === "waiting_answer" ? "tool_call" : previous);
    });
  }

  private async askContinue(): Promise<boolean | "cancelled"> {
    try {
      return await this.askUser("continue", undefined);
    } catch {
      return "cancelled";
    }
  }

  // ------------------------------------------------------------------ inbound handlers (IS-04)

  onAnswer(payload: PayloadOf<"answer">): void {
    const ask = this.pendingAsk;
    if (ask === undefined || ask.requestId !== payload.request_id) {
      this.debug("answer_unmatched", { request_id: payload.request_id });
      return;
    }
    const answer: AskUserAnswer = {};
    if (payload.selected !== undefined) answer.selected = payload.selected;
    if (payload.text !== undefined) answer.text = payload.text;
    ask.resolve(answer);
  }

  onContinue(payload: PayloadOf<"continue">): void {
    const ask = this.pendingAsk;
    if (ask === undefined || ask.kind !== "continue") {
      this.debug("continue_unmatched", {});
      return;
    }
    ask.resolve(payload.proceed);
  }

  onInject(payload: PayloadOf<"inject">): void {
    this.mailbox.push(payload);
  }

  async onCancel(reason: AbortReason = "cancel"): Promise<void> {
    if (!this.turnActive) return;
    this.abortReason = reason;
    this.pendingAsk?.reject(new Error("cancelled"));
    this.abort?.abort();
    const { survivors } = await this.deps.children.terminateAll();
    if (survivors.length > 0) await this.emit(this.errorEvent(`tool child processes survived termination: ${survivors.join(", ")}`, undefined, "warning"));
  }

  async onResume(payload: PayloadOf<"resume">): Promise<void> {
    if (!this.turnActive || this.phase === "idle" || this.phase === "waiting_answer") {
      this.debug("resume_ignored", { phase: this.phase, reason: payload.reason }, "sup");
      return;
    }
    if (payload.reason === "restart") return;
    if (this.abort === undefined) {
      // nothing is in flight: the process was frozen (event loop blocked) and has already recovered - confirm and continue
      await this.emit({ ts: nowTs(), proc: "exec", type: "executor_resumed", reason: payload.reason });
      return;
    }
    if (this.phase === "model_call") {
      this.abortReason = "resume_frozen";
      this.abort?.abort();
      return;
    }
    if (this.phase === "tool_call") {
      this.abortReason = "resume_tool_hang";
      this.abort?.abort();
      await this.deps.children.terminateAll();
    }
  }

  // ------------------------------------------------------------------ finish

  private async finish(stopReason: StopReason, thinking: ThinkingBlock[]): Promise<void> {
    if (stopReason === "cancelled") {
      const note = CANCEL_NOTE(this.toolCallsThisTurn);
      const last = this.messages[this.messages.length - 1];
      if (last !== undefined && last.role === "assistant") last.content = last.content.length > 0 ? `${last.content}\n\n[${note}]` : `[${note}]`;
      else this.messages.push({ role: "assistant", content: `[${note}]` });
    }
    const usage = this.turnUsage;
    this.finishing = true;
    await this.emit(
      {
        ts: nowTs(),
        proc: "exec",
        type: "turn_finished",
        role: "generating",
        uncached_input: usage.uncached_input,
        cache_write: usage.cache_write,
        cache_read: usage.cache_read,
        output: usage.output,
        cost_usd: usage.cost_usd,
        stop_reason: stopReason,
        thinking_payloads: thinking.map((t) => ({ provider: t.provider, payload: t.payload })),
        prompt_id: this.promptId,
      },
      true,
    );
    this.turnActive = false;
    this.finishing = false;
    this.abortReason = undefined;
    this.setPhase("idle");
    this.mailbox.discardLate(this.debug.bind(this));
    const queued = this.queuedPrompt;
    if (queued !== undefined) {
      this.queuedPrompt = undefined;
      void this.runTurn(queued);
    }
  }

  get lastToolCall(): ToolCall | undefined {
    return this.lastRequestedCall;
  }

  get currentTurnIndex(): number {
    return this.turnIndex;
  }
}

function nowTsOf(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** One-line argument summary for debug lines (120 chars, primary argument only - never file contents or prompts). */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  for (const key of ["CommandLine", "file_path", "TargetFile", "DirectoryPath", "SearchPath", "Url", "SkillName", "query", "document_id", "ID", "question"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 120);
  }
  return "";
}
