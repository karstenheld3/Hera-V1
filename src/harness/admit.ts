// Admission module - every run starts with admit() (HERAV1HRNS-SP01 FR-05, HERAV1HRNS-IP01 IS-10).
// The Executor and Supervisor call admit() on their GateProvider before their first effect.
// run_ctx is opaque bytes - Hera never interprets them (FR-06).

import type { AdmitResult, GateProvider } from "./provider.ts";

export { type AdmitResult } from "./provider.ts";

export function admit(
  provider: GateProvider,
  definition_hash: string,
  plug_hash: string,
  interface_version: number,
): AdmitResult {
  return provider.admit(definition_hash, plug_hash, interface_version);
}

export function isAdmitted(result: AdmitResult): result is { admitted: true; run_ctx: Uint8Array; exposure?: string[] } {
  return result.admitted;
}

export function runCtxToWire(run_ctx: Uint8Array): string {
  return Buffer.from(run_ctx).toString("base64");
}

export function runCtxFromWire(wire: string): Uint8Array {
  return new Uint8Array(Buffer.from(wire, "base64"));
}
