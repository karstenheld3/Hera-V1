// GateProvider interface - the socket every effect-producing process calls (HERAV1HRNS-SP01 FR-01, DD-01).
// One instance per process (D-13). The plug behind it decides allow, block, pending, or unavailable.

import type { EffectDescriptor } from "./descriptor.ts";

/** The four gate answers (FR-04). block carries a reason that becomes the tool result. */
export type GateAnswer = "allow" | { answer: "block"; reason: string } | "pending" | "unavailable";

/** Result of admit() - either admitted with a run context, or refused. */
export type AdmitResult = { admitted: true; run_ctx: Uint8Array; exposure?: string[] } | { admitted: false; reason: string };

/** The socket interface every plug implements. Frozen as interface_version 1 (DD-01). */
export interface GateProvider {
  /** Once per process before the first effect. Returns run_ctx and optional exposure list, or refused. */
  admit(definition_hash: string, plug_hash: string, interface_version: number): AdmitResult;

  /** The sole path to dispatch. Returns one of four answers. */
  request(descriptor: EffectDescriptor): GateAnswer | Promise<GateAnswer>;

  /** Resume a pending answer with an optional decision. Event source for a later answer. */
  resolve(effect_id: string, decision?: "allow" | "deny"): void;

  /** Inbound halt from the plug or frontend. */
  halt(reason: string): void;
}
