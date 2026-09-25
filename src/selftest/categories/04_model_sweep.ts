// Category 04 Model Sweep (HERAV1STST-SP01 FR-07; HERAV1STST-IP01 IS-06): one minimal turn per testable model at the
// prefix default effort; asserts a text delta, input tokens above zero, stop reason `end`.

import { roleFor } from "../discovery.ts";
import type { TestResult } from "../report.ts";
import { MINIMAL_SYSTEM, roundTrip, runLive, type RoundTripOutcome, type SelftestContext } from "../runner.ts";

export function sweepFailure(o: RoundTripOutcome): string | undefined {
  if (o.text.trim().length === 0) return "no text delta";
  if (o.usage.uncachedInput + o.usage.cacheRead + o.usage.cacheWrite <= 0) return "usage.uncached_input is 0";
  if (o.stopReason !== "end") return `stop reason '${o.stopReason}' (expected 'end')`;
  return undefined;
}

export async function modelSweepCategory(ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const models = ctx.discovery.testable;
  if (models.length === 0) ctx.out("  no testable models (registry empty after filters)");
  let i = 0;
  for (const t of models) {
    if (ctx.signal.aborted) break;
    i++;
    const role = roleFor(t, t.defaultEffort, ctx.config);
    results.push(
      await runLive(ctx, { category: "04", check: t.model.model_id, model_id: t.model.model_id, provider: t.provider, method: t.method, effort: t.defaultEffort }, `${t.model.model_id} (${t.method}, ${t.defaultEffort})`, t.keyPresent, async () => {
        const outcome = await roundTrip(ctx, role, { system: MINIMAL_SYSTEM });
        return { outcome, failure: sweepFailure(outcome) };
      }, { i, n: models.length }),
    );
  }
  return results;
}
