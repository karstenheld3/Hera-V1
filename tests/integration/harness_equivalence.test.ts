// Pass-through equivalence test v1 (HERAV1HRNS-TP01 TC-12, IG-12, NFR-01).
// v1: structural test - PassThrough allows all effect kinds, produces identical
// answers for identical descriptors. Full baseline comparison comes in U7/U8.

import { describe, expect, test } from "bun:test";
import { EffectDescriptor, type EffectKind } from "../../src/harness/descriptor.ts";
import { Gate } from "../../src/harness/gate.ts";
import { PassThroughPlug } from "../../src/harness/plugs/passthrough.ts";

const KINDS: EffectKind[] = ["tool.invoke", "model.invoke", "memory.write", "net.egress", "process.spawn", "agent.delegate"];

function makeDescriptor(kind: EffectKind, target: string): EffectDescriptor {
  return new EffectDescriptor({
    effect_id: `fx_${kind}_${target}`,
    kind,
    target,
    parameters: { sample: "value" },
  });
}

describe("HERAV1HRNS-TP01 TC-12 Pass-through equivalence (v1)", () => {
  test("PassThrough allows every effect kind", () => {
    const plug = new PassThroughPlug();
    for (const kind of KINDS) {
      const desc = makeDescriptor(kind, "test_target");
      const answer = plug.request(desc);
      expect(answer).toBe("allow");
    }
  });

  test("PassThrough admit returns run_ctx", () => {
    const plug = new PassThroughPlug();
    const result = plug.admit("hash", "plug_hash", 1);
    expect(result.admitted).toBe(true);
    if (result.admitted) {
      expect(result.run_ctx).toBeInstanceOf(Uint8Array);
      expect(result.run_ctx.length).toBe(16);
    }
  });

  test("Gate with PassThrough dispatches all kinds without blocking", async () => {
    const gate = new Gate(new PassThroughPlug());
    gate.admit("", "", 1);
    for (const kind of KINDS) {
      const desc = makeDescriptor(kind, "test_target");
      const result = await gate.execute(desc, {
        dispatch: async () => ({ status: "ok" as const, text: "ok" }),
      });
      expect(result.status).toBe("ok");
      expect(result.end_prompt).toBe(false);
    }
  });

  test("PassThrough produces identical answers for identical descriptors", () => {
    const plug = new PassThroughPlug();
    for (const kind of KINDS) {
      const d1 = makeDescriptor(kind, "target_a");
      const d2 = makeDescriptor(kind, "target_a");
      expect(plug.request(d1)).toBe(plug.request(d2));
    }
  });

  test("PassThrough resolve and halt are no-ops", () => {
    const plug = new PassThroughPlug();
    expect(() => plug.resolve("fx_1")).not.toThrow();
    expect(() => plug.resolve("fx_2", "allow")).not.toThrow();
    expect(() => plug.resolve("fx_3", "deny")).not.toThrow();
    expect(() => plug.halt("test")).not.toThrow();
  });
});
