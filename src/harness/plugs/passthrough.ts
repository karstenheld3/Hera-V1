// PassThrough plug - reference implementation (HERAV1HRNS-SP01 DD-05).
// allow always, locally generated run_ctx, full exposure. Used for tests and equivalence.

import type { EffectDescriptor } from "../descriptor.ts";
import type { AdmitResult, GateAnswer, GateProvider } from "../provider.ts";

export class PassThroughPlug implements GateProvider {
  admit(_definition_hash: string, _plug_hash: string, _interface_version: number): AdmitResult {
    return { admitted: true, run_ctx: crypto.getRandomValues(new Uint8Array(16)) };
  }

  request(_descriptor: EffectDescriptor): GateAnswer {
    return "allow";
  }

  resolve(_effect_id: string, _decision?: "allow" | "deny"): void {}

  halt(_reason: string): void {}
}
