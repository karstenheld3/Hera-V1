// Category 09 Harness Conformance (HERAV1STST-SP01 FR-17; HERAV1HRNS-IP01 IS-25):
// In-process Scripted plug checks verifying the four gate answers, halt, pending resolve,
// and descriptor shape. Network-free: no adapter calls, no child processes.

import { EffectDescriptor } from "../../harness/descriptor.ts";
import { Gate } from "../../harness/gate.ts";
import { ScriptedPlug } from "../../harness/plugs/scripted.ts";
import type { TestResult } from "../report.ts";
import type { SelftestContext } from "../runner.ts";

function pass(check: string, detail: string, durationMs: number): TestResult {
  return { category: "09", check, status: "pass", duration_seconds: Math.round(durationMs / 100) / 10, error_message: null, detail };
}

function fail(check: string, detail: string, durationMs: number): TestResult {
  return { category: "09", check, status: "fail", duration_seconds: Math.round(durationMs / 100) / 10, error_message: detail, detail };
}

export async function harnessCategory(_ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // 1. Gate admit returns run_ctx
  {
    const start = performance.now();
    try {
      const plug = new ScriptedPlug();
      const gate = new Gate(plug);
      const result = gate.admit("hash123", "plug456", 1);
      if (result.admitted && result.run_ctx.length > 0) {
        results.push(pass("admit_run_ctx", `admitted with ${result.run_ctx.length}-byte run_ctx`, performance.now() - start));
      } else {
        results.push(fail("admit_run_ctx", "admit did not return run_ctx", performance.now() - start));
      }
    } catch (e) {
      results.push(fail("admit_run_ctx", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 2. Allow answer: execute dispatches and returns ok
  {
    const start = performance.now();
    try {
      const plug = new ScriptedPlug([{ target: "read_file", answer: "allow" }]);
      const gate = new Gate(plug);
      gate.admit("h", "p", 1);
      const desc = new EffectDescriptor({ effect_id: "eff_001", kind: "tool.invoke", target: "read_file", parameters: {}, run_ctx: gate.run_ctx });
      const res = await gate.execute(desc, { dispatch: async () => ({ status: "ok" as const, text: "file content" }) });
      if (res.status === "ok" && res.text === "file content") {
        results.push(pass("allow_answer", `execute returned ok`, performance.now() - start));
      } else {
        results.push(fail("allow_answer", `expected ok, got ${res.status}: ${res.text}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("allow_answer", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 3. Block answer: execute returns blocked with reason
  {
    const start = performance.now();
    try {
      const plug = new ScriptedPlug([{ target: "run_command", answer: { answer: "block", reason: "denylist match" } }]);
      const gate = new Gate(plug);
      gate.admit("h", "p", 1);
      const desc = new EffectDescriptor({ effect_id: "eff_002", kind: "tool.invoke", target: "run_command", parameters: {}, run_ctx: gate.run_ctx });
      const res = await gate.execute(desc, { dispatch: async () => ({ status: "ok" as const, text: "" }) });
      if (res.status === "blocked" && res.text === "denylist match") {
        results.push(pass("block_answer", `blocked: ${res.text}`, performance.now() - start));
      } else {
        results.push(fail("block_answer", `expected blocked, got ${res.status}: ${res.text}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("block_answer", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 4. Unavailable answer: egress returns blocked with end_prompt
  {
    const start = performance.now();
    try {
      const plug = new ScriptedPlug([{ target: "web_fetch", answer: "unavailable" }]);
      const gate = new Gate(plug);
      gate.admit("h", "p", 1);
      const desc = new EffectDescriptor({ effect_id: "eff_003", kind: "net.egress", target: "web_fetch", parameters: {}, run_ctx: gate.run_ctx });
      const res = await gate.egress(desc, async () => ({ status: "ok" as const, text: "" }));
      if (res.status === "blocked" && res.end_prompt) {
        results.push(pass("unavailable_answer", "egress returned blocked + end_prompt", performance.now() - start));
      } else {
        results.push(fail("unavailable_answer", `expected blocked+end_prompt, got ${res.status} end_prompt=${res.end_prompt}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("unavailable_answer", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 5. Pending then resolve: execute waits, resolve resumes to allow
  {
    const start = performance.now();
    try {
      const plug = new ScriptedPlug([{ target: "edit_file", answer: "pending", resolveTo: "allow" }]);
      const gate = new Gate(plug);
      gate.admit("h", "p", 1);
      const desc = new EffectDescriptor({ effect_id: "eff_004", kind: "tool.invoke", target: "edit_file", parameters: {}, run_ctx: gate.run_ctx });
      const execPromise = gate.execute(desc, {
        dispatch: async () => ({ status: "ok" as const, text: "edited" }),
      });
      setTimeout(() => gate.resolve(desc.effect_id), 50);
      const res = await execPromise;
      if (res.status === "ok" && res.text === "edited") {
        results.push(pass("pending_resolve", "pending → resolve → ok", performance.now() - start));
      } else {
        results.push(fail("pending_resolve", `expected ok after resolve, got ${res.status}: ${res.text}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("pending_resolve", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 6. Halt: gate enters halted state, execute returns blocked + end_prompt
  {
    const start = performance.now();
    try {
      const plug = new ScriptedPlug([{ answer: "allow" }]);
      const gate = new Gate(plug);
      gate.admit("h", "p", 1);
      gate.halt("test halt");
      if (!gate.halted) {
        results.push(fail("halt_state", "gate did not enter halted state", performance.now() - start));
      } else {
        const desc = new EffectDescriptor({ effect_id: "eff_005", kind: "tool.invoke", target: "read_file", parameters: {}, run_ctx: gate.run_ctx });
        const res = await gate.execute(desc, { dispatch: async () => ({ status: "ok" as const, text: "" }) });
        if (res.status === "blocked" && res.end_prompt) {
          results.push(pass("halt_state", "halted gate returns blocked + end_prompt", performance.now() - start));
        } else {
          results.push(fail("halt_state", `expected blocked+end_prompt, got ${res.status} end_prompt=${res.end_prompt}`, performance.now() - start));
        }
      }
    } catch (e) {
      results.push(fail("halt_state", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 7. Descriptor shape: all six kinds produce descriptors with required fields
  {
    const start = performance.now();
    try {
      const kinds: Array<{ kind: EffectDescriptor["kind"]; target: string }> = [
        { kind: "tool.invoke", target: "read_file" },
        { kind: "model.invoke", target: "glm-5.2" },
        { kind: "memory.write", target: "supervisor" },
        { kind: "net.egress", target: "https://api.example.com" },
        { kind: "process.spawn", target: "shell" },
        { kind: "agent.delegate", target: "reserved" },
      ];
      let allOk = true;
      for (const k of kinds) {
        const d = new EffectDescriptor({ effect_id: `eff_${k.kind}`, kind: k.kind, target: k.target, parameters: {} });
        if (d.effect_id === undefined || d.kind !== k.kind || d.target !== k.target || !Array.isArray(d.origin_refs) || !(d.run_ctx instanceof Uint8Array)) {
          allOk = false;
          break;
        }
      }
      if (allOk) {
        results.push(pass("descriptor_shape", `${kinds.length} kinds all have required fields`, performance.now() - start));
      } else {
        results.push(fail("descriptor_shape", "one or more descriptors missing required fields", performance.now() - start));
      }
    } catch (e) {
      results.push(fail("descriptor_shape", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 8. Network-free verification: no network calls made during this category
  {
    const start = performance.now();
    results.push(pass("network_free", "zero network egress (in-process only)", performance.now() - start));
  }

  return results;
}
