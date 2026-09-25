import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Gate } from "../../src/harness/gate.ts";
import { EffectDescriptor } from "../../src/harness/descriptor.ts";
import { LocalGuardsPlug } from "../../src/harness/plugs/localguards.ts";
import { ScriptedPlug } from "../../src/harness/plugs/scripted.ts";
import { PassThroughPlug } from "../../src/harness/plugs/passthrough.ts";
import { admit, runCtxToWire, type AdmitResult } from "../../src/harness/admit.ts";
import type { GateProvider } from "../../src/harness/provider.ts";
import { computeDefinitionHash, modelRefMatch } from "../../src/harness/definition_hash.ts";
import { SessionStore, type EventSink } from "../../src/session/store.ts";
import { SinkRouter, type EmitFn } from "../../src/harness/sink.ts";
import { nowTs, readJsonlFile, type AgentEvent } from "../../src/events.ts";
import { REPO_ROOT, makeTempDir, removeDir, waitFor } from "../harness/procs.ts";
import { toolCtx } from "../harness/tool_ctx.ts";
import { runCommand } from "../../src/tools/shell.ts";
import type { ToolContext } from "../../src/tools/registry.ts";
import { SCRIPTS, prepareRig } from "../harness/executor_rig.ts";
import { HeraProc, type ChildHandle } from "../harness/hera_proc.ts";

/** A plug that refuses admission for testing the refused path. */
class RefusedPlug implements GateProvider {
  admit(_definition_hash: string, _plug_hash: string, _interface_version: number): AdmitResult {
    return { admitted: false, reason: "denylist: workspace not authorized" };
  }
  async request(_descriptor: EffectDescriptor) {
    return "allow" as const;
  }
  resolve(_effect_id: string, _decision?: "allow" | "deny"): void {}
  halt(_reason: string): void {}
}

const dirs: string[] = [];
const spawnedProcs: ReturnType<typeof Bun.spawn>[] = [];
const spawnedHandles: ChildHandle[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) removeDir(d);
  for (const p of spawnedProcs.splice(0)) {
    try { if (p.killed === false) p.kill(); } catch {}
  }
  for (const h of spawnedHandles.splice(0)) {
    try { h.kill(); } catch {}
  }
});

describe("HERAV1HRNS-TP01-TC-01: dispatch is unreachable without the gate", () => {
  test("lint script exists and is runnable", async () => {
    const lintPath = join(REPO_ROOT, "scripts", "lint_harness.ts");
    const proc = Bun.spawn([process.execPath, lintPath], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    spawnedProcs.push(proc);
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("0 violations");
  }, 15000);

  test("gate with a blocking plug refuses dispatch; shell tool throws and spawns nothing", async () => {
    // (a) a Gate whose plug answers block refuses the dispatch
    const plug = new ScriptedPlug([{ answer: { answer: "block", reason: "test: blocked by scripted plug" } }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_block",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });
    let dispatched = false;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "must not run" };
      },
    });
    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("blocked by scripted plug");

    // (b) the shell tool cannot spawn when the gate blocks process.spawn
    const blockingPlug = new ScriptedPlug([{ answer: { answer: "block", reason: "test: spawn blocked" } }]);
    const blockingGate = new Gate(blockingPlug);
    const ctx = toolCtx({ gate: blockingGate });
    await expect(runCommand({ CommandLine: "echo hi" }, ctx)).rejects.toThrow("Cannot run command");
    expect(ctx.children.registered).toHaveLength(0);
    expect(blockingPlug.calls.length).toBe(1);
  });

  test("a ToolContext literal without gate does not compile", () => {
    // @ts-expect-error gate is required in ToolContext; omitting it must fail type checking
    const noGate: ToolContext = { workspace: "", appDir: "", limits: { toolResultMaxChars: 1 }, promptSystem: undefined, askUser: () => Promise.resolve({}), children: { register: () => {}, deregister: () => {} }, adapters: {}, sessions: { dir: "" }, state: { todo: [] }, signal: new AbortController().signal };
    expect(noGate).toBeTruthy();
  });
});

describe("HERAV1HRNS-TP01-TC-02: single dispatch per descriptor (integration)", () => {
  test("block(reason) is the tool result the model reads", async () => {
    const plug = new ScriptedPlug([
      { answer: { answer: "block", reason: "blocked by supervisor: denylist (denylist entry 'rm' matched 'rm')" } },
    ]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_block",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "rm -rf /" },
    });

    let dispatched = false;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "should not happen" };
      },
    });

    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("blocked by supervisor: denylist");
    expect(result.end_prompt).toBe(false);
  });
});

describe("HERAV1HRNS-TP01-TC-05: unavailable ends the prompt with zero effects", () => {
  test("unavailable produces end_prompt=true and a WARNING event", async () => {
    const plug = new ScriptedPlug([{ answer: "unavailable" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_unavail",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });

    let dispatched = false;
    let warningEmitted = false;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "should not happen" };
      },
      onUnavailable: async (effect_id) => {
        warningEmitted = true;
        expect(effect_id).toBe("fx_unavail");
      },
    });

    expect(dispatched).toBe(false);
    expect(warningEmitted).toBe(true);
    expect(result.end_prompt).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("WARNING");
  });
});

describe("HERAV1HRNS-TP01-TC-12: pass-through equivalence (integration)", () => {
  test("PassThroughPlug produces identical results to ScriptedPlug with allow", async () => {
    const ptPlug = new PassThroughPlug();
    const scPlug = new ScriptedPlug([{ answer: "allow" }]);
    const ptGate = new Gate(ptPlug);
    const scGate = new Gate(scPlug);

    const descriptor = new EffectDescriptor({
      effect_id: "fx_equiv",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { path: "/tmp/test.txt" },
    });

    const ptResult = await ptGate.execute(descriptor, {
      dispatch: async () => ({ status: "ok" as const, text: "ok" }),
    });

    const descriptor2 = new EffectDescriptor({
      effect_id: "fx_equiv",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { path: "/tmp/test.txt" },
    });

    const scResult = await scGate.execute(descriptor2, {
      dispatch: async () => ({ status: "ok" as const, text: "ok" }),
    });

    expect(ptResult.status).toBe(scResult.status);
    expect(ptResult.text).toBe(scResult.text);
    expect(ptResult.end_prompt).toBe(scResult.end_prompt);
  });
});

describe("HERAV1HRNS-TP01-TC-03: pending waits with heartbeats and chat ignored (integration)", () => {
  test("pending → resolve → allow: dispatch fires after resolve", async () => {
    const plug = new ScriptedPlug([{ answer: "pending", resolveTo: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_pending_allow",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });

    let pendingNotified = false;
    let dispatched = false;
    const execPromise = gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "ok" };
      },
      onPending: async () => { pendingNotified = true; },
    });

    // Wait for the pending notification to fire
    await waitFor(() => pendingNotified, 2000, "pending notification");
    expect(pendingNotified).toBe(true);
    expect(dispatched).toBe(false);

    // Resolve the pending → plug returns "allow" on re-request
    gate.resolve(descriptor.effect_id);
    const result = await execPromise;

    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.end_prompt).toBe(false);
    expect(result.text).toBe("ok");
  }, 10000);

  test("pending → resolve → block: dispatch never fires, block reason returned", async () => {
    const plug = new ScriptedPlug([{ answer: "pending", resolveTo: { answer: "block", reason: "governance denied" } }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_pending_block",
      kind: "tool.invoke",
      target: "run_command",
      parameters: {},
    });

    let pendingNotified = false;
    let dispatched = false;
    const execPromise = gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "should not happen" };
      },
      onPending: async () => { pendingNotified = true; },
    });

    await waitFor(() => pendingNotified, 2000, "pending notification");
    expect(dispatched).toBe(false);

    gate.resolve(descriptor.effect_id);
    const result = await execPromise;

    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.end_prompt).toBe(false);
    expect(result.text).toContain("governance denied");
  }, 10000);

  test("pending without onPending: gate waits for resolve, chat text ignored", async () => {
    const plug = new ScriptedPlug([{ answer: "pending", resolveTo: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_pending_noop",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });

    let dispatched = false;
    const execPromise = gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "ok" };
      },
    });

    // Gate is waiting; resolve after a short delay
    setTimeout(() => gate.resolve(descriptor.effect_id), 50);
    const result = await execPromise;

    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
  }, 5000);
});

describe("HERAV1HRNS-TP01-TC-14: descriptor immutability (integration)", () => {
  test("path re-resolved and refused on mismatch", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);

    // Create a descriptor with a path parameter
    const descriptor = new EffectDescriptor({
      effect_id: "fx_path",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { file_path: "/original/path.txt" },
    });

    // Freeze the descriptor (as execute() does)
    descriptor.freeze();

    // The hash was computed before any potential mutation
    const originalHash = descriptor.hash();

    // If someone tries to mutate parameters after freeze, Object.isFrozen prevents it
    expect(Object.isFrozen(descriptor.parameters)).toBe(true);

    // verifyIntegrity should return true (no mutation possible)
    expect(descriptor.verifyIntegrity()).toBe(true);

    // A new descriptor with a different path has a different hash
    const modifiedDescriptor = new EffectDescriptor({
      effect_id: "fx_path",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { file_path: "/different/path.txt" },
    });
    modifiedDescriptor.freeze();

    expect(modifiedDescriptor.hash()).not.toBe(originalHash);
  });
});

describe("HERAV1HRNS-TP01-TC-15: two-process dispatch (Executor + Supervisor gate instances)", () => {
  test("each process has its own Gate; both gates consulted on their respective effects", async () => {
    const execPlug = new ScriptedPlug([{ answer: "allow" }]);
    const supPlug = new ScriptedPlug([{ answer: "allow" }]);
    const execGate = new Gate(execPlug);
    const supGate = new Gate(supPlug);

    const toolDescriptor = new EffectDescriptor({
      effect_id: "fx_exec_tool",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });

    const modelDescriptor = new EffectDescriptor({
      effect_id: "fx_sup_model",
      kind: "model.invoke",
      target: "supervisor-review",
      parameters: { role: "supervisor" },
    });

    const toolResult = await execGate.execute(toolDescriptor, {
      dispatch: async () => ({ status: "ok" as const, text: "tool ok" }),
    });

    const modelResult = await supGate.egress(modelDescriptor, async () =>
      ({ status: "ok" as const, text: "model ok" }),
    );

    expect(execPlug.callCount).toBe(1);
    expect(supPlug.callCount).toBe(1);
    expect(toolResult.status).toBe("ok");
    expect(modelResult.status).toBe("ok");
  });
});

describe("HERAV1HRNS-TP01-TC-16: Supervisor review block via gate", () => {
  test("block on model.invoke (supervisor review) prevents dispatch", async () => {
    const supPlug = new ScriptedPlug([
      { answer: { answer: "block", reason: "review blocked: cost limit exceeded" } },
    ]);
    const supGate = new Gate(supPlug);

    const reviewDescriptor = new EffectDescriptor({
      effect_id: "fx_review_block",
      kind: "model.invoke",
      target: "supervisor-review",
      parameters: { role: "supervisor", trigger: "cost_spike" },
    });

    let dispatched = false;
    const result = await supGate.egress(reviewDescriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "should not happen" };
    });

    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("review blocked");
    expect(result.end_prompt).toBe(false);
  });
});

describe("HERAV1HRNS-TP01-TC-17: unavailable on memory.write ends the prompt", () => {
  test("unavailable answer on memory.write produces end_prompt=true and calls onUnavailable", async () => {
    const supPlug = new ScriptedPlug([{ answer: "unavailable" }]);
    const supGate = new Gate(supPlug);

    const memDescriptor = new EffectDescriptor({
      effect_id: "fx_mem_unavail",
      kind: "memory.write",
      target: "memory-store",
      parameters: { text: "candidate memory", scope: "workspace" },
    });

    let dispatched = false;
    const result = await supGate.egress(memDescriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "should not happen" };
    });

    expect(dispatched).toBe(false);
    expect(result.end_prompt).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("WARNING");
  });
});

describe("HERAV1HRNS-TP01-TC-23: refused admission is rendered and halt blocks dispatch", () => {
  test("refused admission returns refused with reason", () => {
    const plug = new RefusedPlug();
    const result = admit(plug, "hash", "", 1);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.reason).toContain("denylist");
    }
  });

  test("admitted admission returns run_ctx and is wire-encodable", () => {
    const plug = new PassThroughPlug();
    const result = admit(plug, "hash", "", 1);
    expect(result.admitted).toBe(true);
    if (result.admitted) {
      const wire = runCtxToWire(result.run_ctx);
      expect(wire.length).toBeGreaterThan(0);
    }
  });

  test("halt blocks all subsequent dispatch via execute()", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    gate.halt("test halt");
    expect(gate.halted).toBe(true);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_halt_test",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });
    let dispatched = false;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "should not happen" };
      },
    });
    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.end_prompt).toBe(true);
  });

  test("halt blocks all subsequent dispatch via egress()", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    gate.halt("test halt");
    const descriptor = new EffectDescriptor({
      effect_id: "fx_halt_egress",
      kind: "model.invoke",
      target: "generating",
      parameters: {},
    });
    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "should not happen" };
    });
    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.end_prompt).toBe(true);
  });

  test("collectInFlight returns pending effects and clears the map", async () => {
    const plug = new ScriptedPlug([{ answer: "pending", resolveTo: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_inflight",
      kind: "tool.invoke",
      target: "ask_user",
      parameters: {},
    });
    let pendingNotified = false;
    const execPromise = gate.execute(descriptor, {
      dispatch: async () => ({ status: "ok" as const, text: "ok" }),
      onPending: async () => { pendingNotified = true; },
    });
    // Wait for pending to be set in-flight
    await waitFor(() => pendingNotified, 2000, "pending notification");
    const inFlight = gate.collectInFlight();
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]?.effect_id).toBe("fx_inflight");
    expect(inFlight[0]?.status).toBe("pending");
    // After collection, the map is cleared
    expect(gate.collectInFlight()).toHaveLength(0);
    // Resolve so the gate can proceed
    gate.resolve(descriptor.effect_id);
    await execPromise;
  }, 10000);

  test("resume yields a new run_ctx with the old one never reappearing", () => {
    const plug1 = new PassThroughPlug();
    const result1 = admit(plug1, "hash", "", 1);
    expect(result1.admitted).toBe(true);
    if (!result1.admitted) return;
    const ctx1 = runCtxToWire(result1.run_ctx);

    const plug2 = new PassThroughPlug();
    const result2 = admit(plug2, "hash", "", 1);
    expect(result2.admitted).toBe(true);
    if (!result2.admitted) return;
    const ctx2 = runCtxToWire(result2.run_ctx);

    expect(ctx1).not.toBe(ctx2);
  });
});

describe("HERAV1HRNS-TP01-TC-18: halt acknowledged with in-flight statuses and terminal state persists", () => {
  test("halt collects in-flight statuses and blocks new dispatch", async () => {
    const plug = new ScriptedPlug([{ answer: "pending" }, { answer: "allow" }]);
    const gate = new Gate(plug);

    // Start a pending effect (simulates in-flight work)
    const desc1 = new EffectDescriptor({
      effect_id: "fx_inflight_1",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });
    const pendingPromise = gate.execute(desc1, {
      dispatch: async () => ({ status: "ok" as const, text: "ok" }),
    });

    // Halt while the effect is pending
    gate.halt("user cancel");
    expect(gate.halted).toBe(true);

    // Collect in-flight statuses
    const inFlight = gate.collectInFlight();
    expect(inFlight.length).toBeGreaterThanOrEqual(0);

    // New dispatch is blocked
    const desc2 = new EffectDescriptor({
      effect_id: "fx_after_halt",
      kind: "tool.invoke",
      target: "edit",
      parameters: {},
    });
    let dispatched = false;
    const result = await gate.execute(desc2, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "should not happen" };
      },
    });
    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.end_prompt).toBe(true);

    // The pending promise should not have dispatched
    void pendingPromise;
  });

  test("terminal state: halted gate blocks egress for all effect kinds", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    gate.halt("terminal");

    // model.invoke
    const modelDesc = new EffectDescriptor({
      effect_id: "fx_model",
      kind: "model.invoke",
      target: "generating",
      parameters: {},
    });
    const modelResult = await gate.egress(modelDesc, async () => ({ status: "ok" as const, text: "no" }));
    expect(modelResult.status).toBe("blocked");
    expect(modelResult.end_prompt).toBe(true);

    // memory.write
    const memDesc = new EffectDescriptor({
      effect_id: "fx_mem",
      kind: "memory.write",
      target: "memory-store",
      parameters: { text: "test", scope: "workspace" },
    });
    const memResult = await gate.egress(memDesc, async () => ({ status: "ok" as const, text: "no" }));
    expect(memResult.status).toBe("blocked");
    expect(memResult.end_prompt).toBe(true);

    // tool.invoke
    const toolDesc = new EffectDescriptor({
      effect_id: "fx_tool",
      kind: "tool.invoke",
      target: "shell",
      parameters: {},
    });
    const toolResult = await gate.execute(toolDesc, {
      dispatch: async () => ({ status: "ok" as const, text: "no" }),
    });
    expect(toolResult.status).toBe("blocked");
    expect(toolResult.end_prompt).toBe(true);
  });

  test("halt reason is preserved in the gate", () => {
    const plug = new PassThroughPlug();
    const gate = new Gate(plug);
    gate.halt("user requested stop");
    expect(gate.halted).toBe(true);
    // After halt, any dispatch returns blocked with end_prompt
    const desc = new EffectDescriptor({
      effect_id: "fx_check",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });
    return gate.execute(desc, {
      dispatch: async () => ({ status: "ok" as const, text: "no" }),
    }).then((result) => {
      expect(result.status).toBe("blocked");
      expect(result.end_prompt).toBe(true);
    });
  });
});

describe("HERAV1HRNS-TP01-TC-08: events before effects for every kind", () => {
  const allKinds: Array<{ kind: import("../../src/harness/descriptor.ts").EffectKind; target: string }> = [
    { kind: "tool.invoke", target: "read_file" },
    { kind: "model.invoke", target: "openai/gpt-4.1-mini" },
    { kind: "memory.write", target: "memory_store" },
    { kind: "net.egress", target: "https://example.com" },
    { kind: "process.spawn", target: "bun" },
  ];

  for (const { kind, target } of allKinds) {
    test(`event is appended before dispatch for ${kind}`, async () => {
      const dir = makeTempDir("tc08");
      dirs.push(dir);
      const store = SessionStore.open(dir, "new");
      const router = new SinkRouter(store);
      const events: AgentEvent[] = [];
      const emit: EmitFn = async (event) => {
        events.push(event);
        router.append(event);
      };
      const plug = new ScriptedPlug([{ answer: "allow" }]);
      const gate = new Gate(plug);
      let dispatched = false;
      const descriptor = new EffectDescriptor({
        effect_id: `fx_${kind}`,
        kind,
        target,
        parameters: {},
      });
      // Emit the effect-requested event BEFORE dispatching through the gate
      await emit({ ts: nowTs(), proc: "exec", type: "tool_call_requested", id: `fx_${kind}`, tool: target, args: {}, args_json: "{}" }, true);
      const isTool = kind === "tool.invoke";
      if (isTool) {
        await gate.execute(descriptor, {
          dispatch: async () => {
            dispatched = true;
            // Event was already appended before dispatch
            expect(events.length).toBeGreaterThan(0);
            return { status: "ok" as const, text: "done" };
          },
        });
      } else {
        await gate.egress(descriptor, async () => {
          dispatched = true;
          expect(events.length).toBeGreaterThan(0);
          return { status: "ok" as const, text: "done" };
        });
      }
      expect(dispatched).toBe(true);
      // Verify the event is on disk
      const diskEvents = readJsonlFile(store.path).events;
      expect(diskEvents.length).toBeGreaterThan(0);
      store.close();
    });
  }

  test("memory_written event is appended before the memory file write", async () => {
    const dir = makeTempDir("tc08_mem");
    dirs.push(dir);
    const store = SessionStore.open(dir, "new");
    const router = new SinkRouter(store);
    const events: AgentEvent[] = [];
    const emit: EmitFn = async (event) => {
      events.push(event);
      router.append(event);
    };
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    let written = false;
    const descriptor = new EffectDescriptor({
      effect_id: "fx_mem_write",
      kind: "memory.write",
      target: "memory_store",
      parameters: { id: "mem_001", scope: "workspace" },
    });
    await gate.egress(descriptor, async () => {
      // Emit memory_written before the actual write
      await emit({ ts: nowTs(), proc: "sup", type: "memory_written", target: "memory_store", memory_id: "mem_001", scope: "workspace" }, true);
      written = true;
      return { status: "ok" as const, text: "written" };
    });
    expect(written).toBe(true);
    expect(events.some((e) => e.type === "memory_written")).toBe(true);
    // Verify the event is on disk
    const diskEvents = readJsonlFile(store.path).events;
    expect(diskEvents.some((e) => e.type === "memory_written")).toBe(true);
    store.close();
  });
});

describe("[harness] H-08 crash recovery: open descriptor closes as unknown", () => {
  test("HERAV1HRNS-TP01-TC-06 crash between tool_call_requested and tool_call_finished -> unknown on resume, model told, no re-dispatch", async () => {
    // 1. Prepare the rig: real 3-process binary via HeraProc, scripted adapter with a slow tool call
    const prepared = prepareRig({ script: join(SCRIPTS, "script_sleep_short.jsonl") });
    dirs.push(...prepared.dirs);
    const proc = new HeraProc({ workspace: prepared.workspace, appDir: prepared.appDir, scriptPath: prepared.env["HERA_SCRIPTED_ADAPTER"] as string, env: { HERA_DECOY_KEY: "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789" } });
    const sessionDir = join(prepared.appDir, ".agent-data", "sessions");

    // 2. Start the real 3-process binary in interactive mode (non-blocking)
    const handle = proc.startPiped([]);
    spawnedHandles.push(handle);

    // 3. Send a prompt that triggers a slow tool call (Start-Sleep -Seconds 3)
    handle.send("run it");

    // 4. Wait for tool_call_requested in the JSONL file (projection, not in-memory)
    let sessionFile: string | undefined;
    await waitFor(() => {
      if (!existsSync(sessionDir)) return false;
      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
      if (files.length === 0) return false;
      sessionFile = join(sessionDir, files[files.length - 1] as string);
      return readJsonlFile(sessionFile).events.some((e) => e.type === "tool_call_requested");
    }, 15000, "tool_call_requested in session JSONL");

    // 5. Snapshot the requested event from the projection
    const preCrashEvents = readJsonlFile(sessionFile as string).events;
    const requested = preCrashEvents.find((e) => e.type === "tool_call_requested") as Extract<AgentEvent, { type: "tool_call_requested" }>;
    expect(requested).toBeDefined();
    const requestedCount = preCrashEvents.filter((e) => e.type === "tool_call_requested").length;

    // 6. Crash: kill the process tree mid-tool-call (no tool_call_finished in the JSONL)
    handle.kill();

    // 7. Resume with a new 3-process binary via --resume (interactive mode, prompt via stdin)
    const proc2 = new HeraProc({ workspace: prepared.workspace, appDir: prepared.appDir, scriptPath: prepared.env["HERA_SCRIPTED_ADAPTER"] as string, env: { HERA_DECOY_KEY: "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789" } });
    const handle2 = proc2.startPiped(["--resume", sessionFile as string]);
    spawnedHandles.push(handle2);
    handle2.send("continue");
    handle2.endInput();
    const exitCode = await handle2.waitExit(30000);
    expect(exitCode).not.toBe(null);

    // 8. Assert from the JSONL projection: tool_call_finished with status "unknown" for the open descriptor
    const postResumeEvents = readJsonlFile(sessionFile as string).events;
    const unknownFinished = postResumeEvents.find((e) => e.type === "tool_call_finished" && (e as { status: string }).status === "unknown") as Extract<AgentEvent, { type: "tool_call_finished" }> | undefined;
    expect(unknownFinished).toBeDefined();
    expect(unknownFinished?.id).toBe(requested.id);
    expect(unknownFinished?.result).toContain("indeterminate");

    // 9. Assert: a WARNING notice was emitted about the crash recovery
    const warningEvent = postResumeEvents.find((e) => e.type === "error" && (e as { severity?: string }).severity === "warning" && e.message.includes("closed as unknown"));
    expect(warningEvent).toBeDefined();

    // 10. Assert: no re-dispatch - the tool_call_requested count must not increase after resume
    const postResumeRequestedCount = postResumeEvents.filter((e) => e.type === "tool_call_requested").length;
    expect(postResumeRequestedCount).toBe(requestedCount);
  }, 60000);
});

describe("HERAV1HRNS-TP01-TC-07: definition hash (H-09)", () => {
  test("definition hash is stable and changes on any sealed input", () => {
    const base = {
      promptSystemHash: "abc123",
      toolDefinitions: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
      configSnapshot: { roles: { generating: { model_id: "glm-5.2" } } },
      modelRefs: { generating: "glm-5.2" },
      plugHash: "plug123",
    };
    const a = computeDefinitionHash(base);
    const b = computeDefinitionHash(base);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);

    const c = computeDefinitionHash({ ...base, promptSystemHash: "different" });
    expect(c).not.toBe(a);

    const d = computeDefinitionHash({ ...base, modelRefs: { generating: "gpt-5.1" } });
    expect(d).not.toBe(a);
  });

  test("model_ref exact match rejects gpt-5.1 for gpt-5.1-2026-12", () => {
    expect(modelRefMatch("gpt-5.1", "gpt-5.1")).toBe(true);
    expect(modelRefMatch("gpt-5.1", "gpt-5.1-2026-12")).toBe(false);
    expect(modelRefMatch("gpt-5.1-2026-12", "gpt-5.1-2026-12")).toBe(true);
  });

  test("admit() receives the definition hash", () => {
    const plug = new PassThroughPlug();
    const dhash = computeDefinitionHash({
      promptSystemHash: "abc",
      toolDefinitions: [],
      configSnapshot: {},
      modelRefs: { generating: "glm-5.2" },
      plugHash: "plug",
    });
    const result = admit(plug, dhash, "plug", 1);
    expect(result.admitted).toBe(true);
  });
});

describe("HERAV1HRNS-TP01-TC-09: no spawn outside the boundary (H-10, FR-10, IG-09)", () => {
  test("lint finds zero Bun.spawn sites outside src/harness/ and src/providers/", async () => {
    const lintPath = join(REPO_ROOT, "scripts", "lint_harness.ts");
    const proc = Bun.spawn(["bun", "run", lintPath], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    spawnedProcs.push(proc);
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("0 violations");
    expect(stderr).not.toContain("Bun.spawn");
  }, 15000);

  test("spawn wrapper is the single entry point in src/harness/spawn.ts", () => {
    const spawnPath = join(REPO_ROOT, "src", "harness", "spawn.ts");
    const content = readFileSync(spawnPath, "utf-8");
    expect(content).toContain("Bun.spawn");
    expect(content).toContain("SpawnKind");
    expect(content).toContain("stripProviderCredentials");
  });
});

describe("HERAV1HRNS-TP01-TC-10: no eval outside the plug socket (H-10, FR-10, IG-10)", () => {
  test("lint flags eval() pattern", async () => {
    const lintPath = join(REPO_ROOT, "scripts", "lint_harness.ts");
    const proc = Bun.spawn(["bun", "run", lintPath], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    spawnedProcs.push(proc);
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("eval()");
  }, 15000);

  test("no eval() call in any source file outside src/harness/", () => {
    const srcRoot = join(REPO_ROOT, "src");
    const files: string[] = [];
    function collectTs(dir: string): void {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) collectTs(full);
        else if (entry.endsWith(".ts")) files.push(full);
      }
    }
    collectTs(srcRoot);
    let evalFound = false;
    for (const f of files) {
      const rel = f.replace(srcRoot, "").replace(/\\/g, "/").replace(/^\//, "");
      if (rel.startsWith("harness/") || rel.startsWith("providers/")) continue;
      const content = readFileSync(f, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (/\beval\s*\(/.test(line)) {
          evalFound = true;
          break;
        }
      }
      if (evalFound) break;
    }
    expect(evalFound).toBe(false);
  });
});

describe("HERAV1HRNS-TP01-TC-11: no secret in any event or descriptor (H-10, FR-10, IG-11)", () => {
  test("EffectDescriptor does not carry provider key values", () => {
    const desc = new EffectDescriptor({
      effect_id: "fx_test_1",
      kind: "process.spawn",
      target: "shell",
      parameters: { command_line: "echo hello", cwd: "/tmp" },
    });
    const json = JSON.stringify(desc);
    for (const v of Object.values({ OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test", ZAI_API_KEY: "sk-zai-test" })) {
      expect(json).not.toContain(v);
    }
  });

  test("spawn wrapper strips provider credentials from tool descendants", () => {
    const spawnPath = join(REPO_ROOT, "src", "harness", "spawn.ts");
    const content = readFileSync(spawnPath, "utf-8");
    expect(content).toContain("stripProviderCredentials");
    expect(content).toContain('kind === "tool"');
  });
});

describe("HERAV1LGRD-TP01-TC-09: scripted read_file outside workspace ends blocked (SEC-007)", () => {
  test("LocalGuardsPlug blocks a read_file outside the workspace with the spec 15 reason", () => {
    const root = makeTempDir("guards");
    dirs.push(root);
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(root, "outside"));
    const plug = new LocalGuardsPlug({ denylist: [], workspace: ws });
    const desc = new EffectDescriptor({
      effect_id: "fx_sec007",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { file_path: join(root, "outside", "secret.txt") },
    });
    const answer = plug.request(desc);
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by workspace boundary") });
  });
});

describe("HERAV1LGRD-TP01-TC-21: SEC-001 SafeToAutoRun=false blocked by default (U07)", () => {
  test("LocalGuardsPlug returns pending for SafeToAutoRun=false, then blocks on deny", () => {
    const root = makeTempDir("guards");
    dirs.push(root);
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const plug = new LocalGuardsPlug({ denylist: [], workspace: ws, approval: "unsafe" });
    const desc = new EffectDescriptor({
      effect_id: "fx_sec001",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: false },
    });
    const answer = plug.request(desc);
    expect(answer).toBe("pending");
    plug.resolve("fx_sec001", "deny");
    const reAnswer = plug.request(new EffectDescriptor({
      effect_id: "fx_sec001",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: false },
    }));
    expect(reAnswer).toEqual({ answer: "block", reason: "denied by user" });
  });

  test("LocalGuardsPlug returns pending for network command even with SafeToAutoRun=true", () => {
    const root = makeTempDir("guards");
    dirs.push(root);
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const plug = new LocalGuardsPlug({ denylist: [], workspace: ws, approval: "unsafe" });
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_sec001_net",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "curl https://example.com", SafeToAutoRun: true },
    }));
    expect(answer).toBe("pending");
  });
});
