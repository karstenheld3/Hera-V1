// Asynchronous supervisor review (HERAV1SUPV-SP01 FR-04; HERAV1SUPV-IP01 IS-04). Triggers fed by event copies and
// heartbeats; one review in flight, later triggers coalesce; the outcome is at most one governance note (600 chars)
// injected into the Executor's next model input. Reviews never block, cancel, or revoke.

import type { ResolvedRole } from "../config/load.ts";
import type { AgentEvent } from "../events.ts";
import type { Usage } from "../models.ts";
import type { RuleFile } from "../prompt/loader.ts";
import type { PayloadOf } from "../process/envelope.ts";
import type { ProviderAdapter } from "../providers/base.ts";
import type { Gate } from "../harness/gate.ts";
import { egressModelInvoke } from "../providers/registry.ts";
import type { EmitFn } from "../harness/sink.ts";

export type TriggerReason = "every_n_calls" | "error_streak" | "repeated_edit" | "cost_spike";

export const REVIEW_SYSTEM_PROMPT = `You are the Hera Supervisor reviewing an autonomous coding agent's recent tool activity.
Decide whether the agent needs one short corrective note. Reply with exactly one of:
- the literal text "no action" when the activity is reasonable, or
- one imperative note of at most 600 characters telling the agent what to change now.
When the activity violates one of the loaded rules, name the rule file and quote the violated sentence.
Never restate rules wholesale, never invent facts, never ask questions.`;

export const GOVERNANCE_NOTE_MAX = 600;
export const RULE_TEXT_CAP = 2000;
export const CALL_SUMMARY_CAP = 300;

export interface CallRecord {
  id: string;
  tool: string;
  argsSummary: string;
  status: string;
  startedAt: number;
  durationMs: number | undefined;
  target: string | undefined;
}

export interface ReviewInput {
  reasons: TriggerReason[];
  calls: CallRecord[];
  userRequest: string;
  turnCostUsd: number;
  rules: Array<{ name: string; text: string }>;
}

const WRITE_TOOLS = new Set(["edit", "multi_edit", "write_to_file"]);

/** Observes copies of Executor events and heartbeats and fires review triggers. */
export class ReviewTriggers {
  private calls: CallRecord[] = [];
  private callsSinceReview = 0;
  private errorStreak = 0;
  private turnCost = 0;
  private costAlerted = false;
  userRequest = "";
  turnIndex = 0;
  totalCalls = 0;

  constructor(
    private readonly cfg: { reviewEveryCalls: number; costAlertUsd: number },
    private readonly fire: (reason: TriggerReason) => void,
    private readonly costAlert: (costUsd: number) => void,
  ) {}

  get recentCalls(): CallRecord[] {
    return this.calls.slice(-Math.max(1, this.cfg.reviewEveryCalls));
  }

  get turnCostUsd(): number {
    return this.turnCost;
  }

  /** seed from a re-seeded session: counts only, no triggers */
  seedCallCount(sinceReview: number, total: number): void {
    this.callsSinceReview = sinceReview;
    this.totalCalls = total;
  }

  onHeartbeat(payload: PayloadOf<"heartbeat">): void {
    const cost = payload.turn_usage?.cost_usd;
    if (cost !== undefined) this.observeCost(cost);
  }

  private observeCost(cost: number): void {
    this.turnCost = Math.max(this.turnCost, cost);
    if (!this.costAlerted && this.turnCost > this.cfg.costAlertUsd) {
      this.costAlerted = true;
      this.costAlert(this.turnCost);
      this.fire("cost_spike");
    }
  }

  onEvent(event: AgentEvent, now = Date.now()): void {
    if (event.proc !== "exec") return;
    switch (event.type) {
      case "user_message":
        this.turnIndex++;
        this.userRequest = extractUserRequest(event.content);
        this.calls = [];
        this.errorStreak = 0;
        this.turnCost = 0;
        this.costAlerted = false;
        break;
      case "tool_call_requested": {
        const target = WRITE_TOOLS.has(event.tool) ? String(event.args["file_path"] ?? event.args["TargetFile"] ?? "") : undefined;
        this.calls.push({ id: event.id, tool: event.tool, argsSummary: (event.args_json ?? JSON.stringify(event.args)).slice(0, CALL_SUMMARY_CAP), status: "pending", startedAt: now, durationMs: undefined, target: target !== undefined && target.length > 0 ? normalizeTarget(target) : undefined });
        this.totalCalls++;
        this.callsSinceReview++;
        if (this.callsSinceReview >= this.cfg.reviewEveryCalls) {
          this.callsSinceReview = 0;
          this.fire("every_n_calls");
        }
        if (target !== undefined) {
          const same = this.calls.filter((c) => c.target !== undefined && c.target === normalizeTarget(target)).length;
          if (same === 3) this.fire("repeated_edit");
        }
        break;
      }
      case "tool_call_finished": {
        const call = this.calls.find((c) => c.id === event.id);
        if (call !== undefined) {
          call.status = event.status;
          call.durationMs = now - call.startedAt;
        }
        if (event.status === "error") {
          this.errorStreak++;
          if (this.errorStreak === 3) this.fire("error_streak");
        } else this.errorStreak = 0;
        break;
      }
      case "turn_finished":
        if (event.role === "generating" && typeof event.cost_usd === "number") this.observeCost(event.cost_usd);
        break;
      default:
        break;
    }
  }
}

function normalizeTarget(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function extractUserRequest(content: string): string {
  const m = /<user_request>\n([\s\S]*?)\n<\/user_request>/.exec(content);
  return (m?.[1] ?? content).slice(0, 2000);
}

export function buildReviewInput(reasons: TriggerReason[], calls: CallRecord[], userRequest: string, turnCostUsd: number, rules: RuleFile[]): ReviewInput {
  return { reasons, calls, userRequest, turnCostUsd, rules: rules.filter((r) => r.skippedReason === undefined).map((r) => ({ name: r.filename, text: r.content.slice(0, RULE_TEXT_CAP) })) };
}

export function renderReviewRequest(input: ReviewInput): string {
  const lines = [`Trigger: ${input.reasons.join(", ")}`, `Turn cost so far: $${input.turnCostUsd.toFixed(4)}`, "", "User request:", input.userRequest, "", `Last ${input.calls.length} tool calls:`];
  for (const c of input.calls) lines.push(`- ${c.tool} ${c.argsSummary} -> ${c.status}${c.durationMs !== undefined ? ` (${c.durationMs} ms)` : ""}`);
  if (input.rules.length > 0) {
    lines.push("", "Loaded rules:");
    for (const r of input.rules) lines.push(`<rule file="${r.name}">`, r.text, "</rule>");
  }
  return lines.join("\n");
}

export interface ReviewOutcome {
  note: string | undefined;
  usage: Usage;
  request: string;
  text: string;
}

export function parseReviewText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /^["']?no action\.?["']?\.?$/i.test(trimmed)) return undefined;
  return trimmed.length > GOVERNANCE_NOTE_MAX ? `${trimmed.slice(0, GOVERNANCE_NOTE_MAX - 3)}...` : trimmed;
}

export async function runReview(input: ReviewInput, adapter: ProviderAdapter, role: ResolvedRole, gate: Gate, signal?: AbortSignal, emit?: EmitFn): Promise<ReviewOutcome> {
  const request = renderReviewRequest(input);
  let text = "";
  let usage: Usage = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for await (const delta of egressModelInvoke(adapter, gate, { system: REVIEW_SYSTEM_PROMPT, tools: [], messages: [{ role: "user", content: request }], role }, signal, emit)) {
    if (delta.kind === "text") text += delta.text;
    else if (delta.kind === "usage") usage = delta.usage;
  }
  return { note: parseReviewText(text), usage, request, text };
}

/** One review in flight; triggers during a review coalesce into the next one. */
export class Reviewer {
  private inFlight = false;
  private pending = new Set<TriggerReason>();
  private stopped = false;

  constructor(private readonly run: (reasons: TriggerReason[]) => Promise<void>) {}

  schedule(reason: TriggerReason): void {
    if (this.stopped) return;
    this.pending.add(reason);
    if (this.inFlight) return;
    void this.drain();
  }

  get busy(): boolean {
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    this.inFlight = true;
    try {
      while (this.pending.size > 0 && !this.stopped) {
        const reasons = [...this.pending];
        this.pending.clear();
        try {
          await this.run(reasons);
        } catch {
          /* review failures never disturb the Executor */
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
  }
}
