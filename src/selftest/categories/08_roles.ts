// Category 08 Roles (HERAV1STST-SP01 FR-11; HERAV1STST-IP01 IS-06): the four configured roles plus the websearch alias
// deduplicated by (provider, model, effort) - one minimal round trip per distinct model, reported per role.

import type { ResolvedRole } from "../../config/load.ts";
import { ROLE_NAMES } from "../../models.ts";
import type { TestResult } from "../report.ts";
import { MINIMAL_SYSTEM, roundTrip, runLive, type SelftestContext } from "../runner.ts";
import { sweepFailure } from "./04_model_sweep.ts";

export function distinctRoles(roles: Record<string, ResolvedRole>): Array<{ role: ResolvedRole; names: string[] }> {
  const groups = new Map<string, { role: ResolvedRole; names: string[] }>();
  for (const name of [...ROLE_NAMES, "websearch"] as const) {
    const role = roles[name];
    if (role === undefined) continue;
    const key = `${role.provider}|${role.modelId}|${role.effort}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { role, names: [name] });
    else group.names.push(name);
  }
  return [...groups.values()];
}

export async function rolesCategory(ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const groups = distinctRoles(ctx.config.roles);
  let i = 0;
  for (const group of groups) {
    if (ctx.signal.aborted) break;
    i++;
    const role = group.role;
    const keyPresent = ctx.keysPresent.has(role.provider);
    const label = `${group.names.join(", ")} ${role.modelId} (${role.method}, ${role.effort})`;
    const outcome = await runLive(ctx, { category: "08", check: group.names[0] as string, model_id: role.modelId, provider: role.provider, method: role.method, effort: role.effort }, label, keyPresent, async () => {
      const o = await roundTrip(ctx, role, { system: MINIMAL_SYSTEM });
      return { outcome: o, failure: sweepFailure(o) };
    }, { i, n: groups.length });
    results.push(outcome);
    // one line per additional role sharing the model (FR-11: four roles reported)
    for (const extra of group.names.slice(1)) results.push({ ...outcome, check: extra, duration_seconds: 0, usage: undefined, cost_usd: 0, detail: `same model as ${group.names[0]}` });
  }
  return results;
}
