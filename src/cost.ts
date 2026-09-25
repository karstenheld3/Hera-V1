// Cost formula shared by the Executor (turn_usage, turn_finished.cost_usd) and the CLI ledger (HERAV1PRVD-SP01 DD-07).
// uncached_input x input_rate + cache_write x write_rate + cache_read x cached_rate + output x output_rate.

import type { ModelPrice, PricingTable } from "./config/load.ts";
import type { Usage } from "./models.ts";

export function priceFor(pricing: PricingTable, provider: string, modelId: string): ModelPrice | undefined {
  return pricing[provider]?.[modelId];
}

/** USD for one call; undefined when the model has no pricing entry (rendered as `?`). */
export function computeCost(usage: Usage, price: ModelPrice | undefined): number | undefined {
  if (price === undefined) return undefined;
  const cacheReadRate = price.cached_per_1m ?? price.input_per_1m;
  const cacheWriteRate = price.cache_write_per_1m ?? price.input_per_1m * 1.25;
  const usd = (usage.uncachedInput * price.input_per_1m + usage.cacheWrite * cacheWriteRate + usage.cacheRead * cacheReadRate + usage.output * price.output_per_1m) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

export function formatUsd(usd: number | undefined | null): string {
  if (usd === undefined || usd === null) return "?";
  return `$${usd.toFixed(4)}`;
}

/** LOG-GN-04 duration format: `245 ms`, `1.5 secs`, `2 mins 30 secs`, `1 hour 15 mins`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms * 10) / 10} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} secs`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ${seconds} sec${seconds === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"} ${rest} min${rest === 1 ? "" : "s"}`;
}
