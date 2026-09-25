// Category 05 Model Effort Matrix (HERAV1STST-SP01 FR-08, DD-04; HERAV1STST-IP01 IS-06): the cheapest model per parameter
// method times its effort levels (the prefix array or low|medium|high); a level rejected by the provider fails alone.

import { cheapestPerMethod, roleFor } from "../discovery.ts";
import type { TestResult } from "../report.ts";
import { MINIMAL_SYSTEM, roundTrip, runLive, type SelftestContext } from "../runner.ts";
import { sweepFailure } from "./04_model_sweep.ts";

export async function effortMatrixCategory(ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const cheapest = cheapestPerMethod(ctx.discovery.testable);
  const cells: Array<{ method: string; model: ReturnType<typeof cheapestPerMethod> extends Map<unknown, infer V> ? V : never; level: string }> = [];
  for (const [method, model] of cheapest) for (const level of model.levels) cells.push({ method, model, level });
  if (cells.length === 0) ctx.out("  no priced testable model per method - nothing to run");
  let i = 0;
  for (const cell of cells) {
    if (ctx.signal.aborted) break;
    i++;
    const t = cell.model;
    let role;
    try {
      role = roleFor(t, cell.level, ctx.config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.out(`  [ ${i} / ${cells.length} ] ${t.model.model_id} (${cell.method}, ${cell.level})...`);
      ctx.out(`    FAIL: ${message}`);
      results.push({ category: "05", check: `${t.model.model_id}@${cell.level}`, model_id: t.model.model_id, provider: t.provider, method: cell.method, effort: cell.level, status: "fail", duration_seconds: 0, error_message: message });
      continue;
    }
    results.push(
      await runLive(ctx, { category: "05", check: `${t.model.model_id}@${cell.level}`, model_id: t.model.model_id, provider: t.provider, method: cell.method, effort: cell.level }, `${t.model.model_id} (${cell.method}, ${cell.level})`, t.keyPresent, async () => {
        const outcome = await roundTrip(ctx, role, { system: MINIMAL_SYSTEM });
        return { outcome, failure: sweepFailure(outcome) };
      }, { i, n: cells.length }),
    );
  }
  return results;
}
