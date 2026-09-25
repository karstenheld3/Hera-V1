// Scripted plug - test fixture with scripted answers and delays (HERAV1HRNS-SP01 DD-05).
// Used by harness_gate.test.ts and harness_conformance.test.ts to exercise all four answers.

import type { EffectDescriptor } from "../descriptor.ts";
import type { AdmitResult, GateAnswer, GateProvider } from "../provider.ts";

export type ScriptedAnswer = GateAnswer | { answer: "block"; reason: string };

export interface ScriptedEntry {
  /** Match by target (tool name) or a predicate. If neither, matches any. */
  target?: string;
  match?: (descriptor: EffectDescriptor) => boolean;
  answer: ScriptedAnswer;
  /** Optional delay in ms before returning the answer. */
  delay_ms?: number;
  /** Answer to return after resolve(effect_id) when the initial answer was "pending". */
  resolveTo?: ScriptedAnswer;
}

export class ScriptedPlug implements GateProvider {
  private entries: ScriptedEntry[];
  private callLog: EffectDescriptor[] = [];
  private readonly resolvedEffects = new Set<string>();
  private _exposure?: string[];

  constructor(entries: ScriptedEntry[] = [], exposure?: string[]) {
    this.entries = entries;
    this._exposure = exposure;
  }

  admit(_definition_hash: string, _plug_hash: string, _interface_version: number): AdmitResult {
    return { admitted: true, run_ctx: new Uint8Array(16).fill(0x42), ...(this._exposure !== undefined ? { exposure: this._exposure } : {}) };
  }

  async request(descriptor: EffectDescriptor): Promise<GateAnswer> {
    this.callLog.push(descriptor);
    const entry = this.entries.find(
      (e) =>
        (e.target !== undefined && e.target === descriptor.target) ||
        (e.match !== undefined && e.match(descriptor)) ||
        (e.target === undefined && e.match === undefined),
    );
    if (this.resolvedEffects.has(descriptor.effect_id) && entry?.resolveTo !== undefined) {
      return entry.resolveTo;
    }
    const answer = entry?.answer ?? "allow";
    if (entry?.delay_ms !== undefined && entry.delay_ms > 0) {
      await new Promise((r) => setTimeout(r, entry.delay_ms));
    }
    return answer;
  }

  resolve(effect_id: string, _decision?: "allow" | "deny"): void {
    this.resolvedEffects.add(effect_id);
  }

  halt(_reason: string): void {}

  get calls(): readonly EffectDescriptor[] {
    return this.callLog;
  }

  get callCount(): number {
    return this.callLog.length;
  }

  reset(): void {
    this.callLog = [];
    this.entries = [];
  }

  setEntries(entries: ScriptedEntry[]): void {
    this.entries = entries;
  }
}
