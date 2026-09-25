// CostLedger (HERAV1CLI-SP01 FR-02; HERAV1CLI-IP01 IS-01). Four roles, fed by turn_finished (role) and
// checkpoint_created (compacting); a model without pricing shows `?` and marks the total `?+`.

import type { PricingTable, ResolvedConfig } from "../config/load.ts";
import { computeCost, formatUsd, priceFor } from "../cost.ts";
import type { AgentEvent } from "../events.ts";
import { ROLE_NAMES, type RoleName, type Usage } from "../models.ts";
import type { Projection } from "../session/projection.ts";

export interface RoleLedger {
  modelId: string;
  calls: number;
  usage: Usage;
  costUsd: number | null;
}

export class CostLedger {
  readonly roles = new Map<RoleName, RoleLedger>();
  lastTurn: { usage: Usage; costUsd: number | null } | undefined;

  constructor(
    private readonly pricing: PricingTable,
    private readonly models: Record<RoleName, { provider: string; modelId: string }>,
  ) {}

  static fromConfig(cfg: ResolvedConfig): CostLedger {
    const models = {} as Record<RoleName, { provider: string; modelId: string }>;
    for (const r of ROLE_NAMES) models[r] = { provider: cfg.roles[r].provider, modelId: cfg.roles[r].modelId };
    return new CostLedger(cfg.pricing, models);
  }

  private record(role: RoleName, usage: Usage, eventCost: number | null | undefined): number | null {
    const model = this.models[role];
    const entry = this.roles.get(role) ?? { modelId: model.modelId, calls: 0, usage: { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, costUsd: 0 };
    entry.calls++;
    entry.usage = { uncachedInput: entry.usage.uncachedInput + usage.uncachedInput, cacheWrite: entry.usage.cacheWrite + usage.cacheWrite, cacheRead: entry.usage.cacheRead + usage.cacheRead, output: entry.usage.output + usage.output };
    const cost = typeof eventCost === "number" ? eventCost : computeCost(usage, priceFor(this.pricing, model.provider, model.modelId));
    entry.costUsd = cost === undefined || entry.costUsd === null ? null : Math.round((entry.costUsd + cost) * 1e6) / 1e6;
    this.roles.set(role, entry);
    return cost ?? null;
  }

  onEvent(event: AgentEvent): void {
    if (event.type === "turn_finished") {
      const usage: Usage = { uncachedInput: event.uncached_input, cacheWrite: event.cache_write, cacheRead: event.cache_read, output: event.output };
      const cost = this.record(event.role, usage, event.cost_usd);
      if (event.role === "generating") this.lastTurn = { usage, costUsd: cost };
    } else if (event.type === "checkpoint_created" && event.usage !== undefined) {
      this.record("compacting", { uncachedInput: event.usage.uncached_input, cacheWrite: event.usage.cache_write, cacheRead: event.usage.cache_read, output: event.usage.output }, event.usage.cost_usd);
    }
  }

  rebuild(projection: Projection): void {
    this.roles.clear();
    this.lastTurn = undefined;
    for (const e of projection.events) this.onEvent(e);
  }

  get totalUsd(): number {
    let total = 0;
    for (const r of this.roles.values()) total += r.costUsd ?? 0;
    return Math.round(total * 1e6) / 1e6;
  }

  get partial(): boolean {
    return [...this.roles.values()].some((r) => r.costUsd === null);
  }

  formatTotal(): string {
    return `${formatUsd(this.totalUsd)}${this.partial ? "+" : ""}`.replace("$?", "?");
  }

  /** `Turn: in=21050 (cache 18200, write 500) out=412 | $0.0164 | session $0.0164` */
  turnLine(event: Extract<AgentEvent, { type: "turn_finished" }>): string {
    const cost = typeof event.cost_usd === "number" ? event.cost_usd : this.lastTurn?.costUsd ?? null;
    const write = event.cache_write > 0 ? `, write ${event.cache_write}` : "";
    return `Turn: in=${event.uncached_input + event.cache_read + event.cache_write} (cache ${event.cache_read}${write}) out=${event.output} | ${formatUsd(cost)} | session ${this.formatTotal()}`;
  }

  /** One line per used role plus the total (FR-02 /cost). */
  costTable(): string[] {
    const lines: string[] = [];
    for (const role of ROLE_NAMES) {
      const r = this.roles.get(role);
      if (r === undefined || r.calls === 0) continue;
      lines.push(`${role.padEnd(12)} ${r.modelId.padEnd(28)} calls=${r.calls} in=${r.usage.uncachedInput + r.usage.cacheRead + r.usage.cacheWrite} (cache ${r.usage.cacheRead}, write ${r.usage.cacheWrite}) out=${r.usage.output} | ${r.costUsd === null ? "?" : formatUsd(r.costUsd)}`);
    }
    if (lines.length === 0) lines.push("No model calls yet.");
    lines.push(`Session total: ${this.formatTotal()}`);
    return lines;
  }
}
