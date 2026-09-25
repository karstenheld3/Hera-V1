// Gate module - the one chokepoint for tool dispatch (HERAV1HRNS-SP01 FR-01).
// Wraps a GateProvider plug and routes the four answers (FR-04).
// One Gate instance per effect-producing process (D-13).

import type { EffectDescriptor } from "./descriptor.ts";
import type { AdmitResult, GateAnswer, GateProvider } from "./provider.ts";

export interface GateExecuteResult {
  status: "ok" | "error" | "cancelled" | "blocked";
  text: string;
  /** True when the gate returned unavailable - the running prompt must end. */
  end_prompt: boolean;
}

export interface GateExecuteOptions {
  /** The dispatch function called when the gate answers allow. */
  dispatch: () => Promise<{ status: "ok" | "error" | "cancelled"; text: string }>;
  /** Called when the gate answers unavailable, before execute returns. */
  onUnavailable?: (effect_id: string) => Promise<void>;
  /** Called when the gate answers pending, before waiting for resolve. */
  onPending?: (effect_id: string) => Promise<void>;
}

export class Gate {
  private _run_ctx: Uint8Array = new Uint8Array(0);
  private _admitted = false;
  private _halted = false;
  private readonly _inFlight = new Map<string, { kind: string; target: string; status: string }>();
  private readonly pendingResolvers = new Map<string, () => void>();

  constructor(private readonly provider: GateProvider) {}

  get admitted(): boolean {
    return this._admitted;
  }

  get halted(): boolean {
    return this._halted;
  }

  get run_ctx(): Uint8Array {
    return this._run_ctx;
  }

  get plug(): GateProvider {
    return this.provider;
  }

  admit(definition_hash: string, plug_hash: string, interface_version: number): AdmitResult {
    const result = this.provider.admit(definition_hash, plug_hash, interface_version);
    if (result.admitted) {
      this._admitted = true;
      this._run_ctx = result.run_ctx;
    }
    return result;
  }

  /** The sole path to dispatch. Routes the four answers per FR-04. */
  async execute(descriptor: EffectDescriptor, options: GateExecuteOptions): Promise<GateExecuteResult> {
    if (this._halted) return { status: "blocked", text: "gate: halted", end_prompt: true };
    descriptor.freeze();
    this._inFlight.set(descriptor.effect_id, { kind: descriptor.kind, target: descriptor.target, status: "dispatching" });
    const answer: GateAnswer = await this.provider.request(descriptor);

    if (answer === "allow") {
      if (!descriptor.verifyIntegrity()) {
        this._inFlight.delete(descriptor.effect_id);
        return { status: "blocked", text: "gate: descriptor parameters changed between request and dispatch (path mismatch)", end_prompt: false };
      }
      this._inFlight.set(descriptor.effect_id, { kind: descriptor.kind, target: descriptor.target, status: "dispatching" });
      try {
        const result = await options.dispatch();
        this._inFlight.delete(descriptor.effect_id);
        return { status: result.status, text: result.text, end_prompt: false };
      } catch (error) {
        this._inFlight.delete(descriptor.effect_id);
        throw error;
      }
    }

    if (typeof answer === "object" && answer.answer === "block") {
      this._inFlight.delete(descriptor.effect_id);
      return { status: "blocked", text: answer.reason, end_prompt: false };
    }

    if (answer === "pending") {
      this._inFlight.set(descriptor.effect_id, { kind: descriptor.kind, target: descriptor.target, status: "pending" });
      if (options.onPending !== undefined) await options.onPending(descriptor.effect_id);
      await this.waitForResolve(descriptor.effect_id);
      if (this._halted) {
        this._inFlight.delete(descriptor.effect_id);
        return { status: "blocked", text: "gate: halted during pending", end_prompt: true };
      }
      const resolvedAnswer: GateAnswer = await this.provider.request(descriptor);
      if (resolvedAnswer === "allow") {
        if (!descriptor.verifyIntegrity()) {
          this._inFlight.delete(descriptor.effect_id);
          return { status: "blocked", text: "gate: descriptor parameters changed between request and dispatch (path mismatch)", end_prompt: false };
        }
        try {
          const result = await options.dispatch();
          this._inFlight.delete(descriptor.effect_id);
          return { status: result.status, text: result.text, end_prompt: false };
        } catch (error) {
          this._inFlight.delete(descriptor.effect_id);
          throw error;
        }
      }
      if (typeof resolvedAnswer === "object" && resolvedAnswer.answer === "block") {
        this._inFlight.delete(descriptor.effect_id);
        return { status: "blocked", text: resolvedAnswer.reason, end_prompt: false };
      }
      // unavailable after pending
      this._inFlight.delete(descriptor.effect_id);
      if (options.onUnavailable !== undefined) await options.onUnavailable(descriptor.effect_id);
      return { status: "blocked", text: `WARNING: gate unavailable for effect ${descriptor.effect_id}`, end_prompt: true };
    }

    // unavailable
    this._inFlight.delete(descriptor.effect_id);
    if (options.onUnavailable !== undefined) await options.onUnavailable(descriptor.effect_id);
    return { status: "blocked", text: `WARNING: gate unavailable for effect ${descriptor.effect_id}`, end_prompt: true };
  }

  /** The path for non-tool effects (model.invoke, net.egress, process.spawn, memory.write). */
  async egress(descriptor: EffectDescriptor, dispatch: () => Promise<{ status: "ok" | "error" | "cancelled"; text: string }>, onPending?: (effect_id: string) => Promise<void>): Promise<{ status: "ok" | "error" | "cancelled" | "blocked"; text: string; end_prompt: boolean }> {
    if (this._halted) return { status: "blocked", text: "gate: halted", end_prompt: true };
    descriptor.freeze();
    this._inFlight.set(descriptor.effect_id, { kind: descriptor.kind, target: descriptor.target, status: "dispatching" });
    const answer: GateAnswer = await this.provider.request(descriptor);

    if (answer === "allow") {
      if (!descriptor.verifyIntegrity()) {
        this._inFlight.delete(descriptor.effect_id);
        return { status: "blocked", text: "gate: descriptor parameters changed between request and dispatch", end_prompt: false };
      }
      try {
        const result = await dispatch();
        this._inFlight.delete(descriptor.effect_id);
        return { status: result.status, text: result.text, end_prompt: false };
      } catch (error) {
        this._inFlight.delete(descriptor.effect_id);
        throw error;
      }
    }

    if (typeof answer === "object" && answer.answer === "block") {
      this._inFlight.delete(descriptor.effect_id);
      return { status: "blocked", text: answer.reason, end_prompt: false };
    }

    if (answer === "pending") {
      this._inFlight.set(descriptor.effect_id, { kind: descriptor.kind, target: descriptor.target, status: "pending" });
      if (onPending !== undefined) await onPending(descriptor.effect_id);
      await this.waitForResolve(descriptor.effect_id);
      if (this._halted) {
        this._inFlight.delete(descriptor.effect_id);
        return { status: "blocked", text: "gate: halted during pending", end_prompt: true };
      }
      const resolvedAnswer: GateAnswer = await this.provider.request(descriptor);
      if (resolvedAnswer === "allow") {
        if (!descriptor.verifyIntegrity()) {
          this._inFlight.delete(descriptor.effect_id);
          return { status: "blocked", text: "gate: descriptor parameters changed between request and dispatch", end_prompt: false };
        }
        try {
          const result = await dispatch();
          this._inFlight.delete(descriptor.effect_id);
          return { status: result.status, text: result.text, end_prompt: false };
        } catch (error) {
          this._inFlight.delete(descriptor.effect_id);
          throw error;
        }
      }
      if (typeof resolvedAnswer === "object" && resolvedAnswer.answer === "block") {
        this._inFlight.delete(descriptor.effect_id);
        return { status: "blocked", text: resolvedAnswer.reason, end_prompt: false };
      }
      this._inFlight.delete(descriptor.effect_id);
      return { status: "blocked", text: `WARNING: gate unavailable for effect ${descriptor.effect_id}`, end_prompt: true };
    }

    this._inFlight.delete(descriptor.effect_id);
    return { status: "blocked", text: `WARNING: gate unavailable for effect ${descriptor.effect_id}`, end_prompt: true };
  }

  /** Waits for resolve(effect_id) to be called. Returns immediately if already halted. */
  private waitForResolve(effect_id: string): Promise<void> {
    if (this._halted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pendingResolvers.set(effect_id, resolve);
    });
  }

  resolve(effect_id: string, decision?: "allow" | "deny"): void {
    this.provider.resolve(effect_id, decision);
    const resolver = this.pendingResolvers.get(effect_id);
    if (resolver !== undefined) {
      this.pendingResolvers.delete(effect_id);
      resolver();
    }
  }

  halt(reason: string): void {
    this._halted = true;
    this.provider.halt(reason);
    for (const [, resolver] of this.pendingResolvers) resolver();
    this.pendingResolvers.clear();
  }

  /** Collect in-flight effect statuses for the halted event (FR-05). */
  collectInFlight(): { effect_id: string; kind: string; target: string; status: string }[] {
    const out = Array.from(this._inFlight.entries()).map(([effect_id, v]) => ({ effect_id, ...v }));
    this._inFlight.clear();
    return out;
  }
}
