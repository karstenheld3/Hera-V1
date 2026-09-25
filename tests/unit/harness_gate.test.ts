import { describe, expect, test } from "bun:test";
import { Gate } from "../../src/harness/gate.ts";
import { EffectDescriptor } from "../../src/harness/descriptor.ts";
import { PassThroughPlug } from "../../src/harness/plugs/passthrough.ts";
import { ScriptedPlug } from "../../src/harness/plugs/scripted.ts";

describe("HERAV1HRNS-TP01-TC-01: bypass detection", () => {
  test("execute() consults the plug and dispatches when the answer is allow", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_1",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { path: "/tmp/test.txt" },
    });

    let dispatched = false;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "file contents" };
      },
    });

    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("file contents");
    expect(result.end_prompt).toBe(false);
  });
});

describe("HERAV1HRNS-TP01-TC-02: single dispatch per descriptor", () => {
  test("allow dispatches exactly once", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_2",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });

    let count = 0;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        count++;
        return { status: "ok" as const, text: `call ${count}` };
      },
    });

    expect(count).toBe(1);
    expect(result.status).toBe("ok");
  });

  test("block does not dispatch", async () => {
    const plug = new ScriptedPlug([{ answer: { answer: "block", reason: "denylist entry 'rm' matched 'rm'" } }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_3",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "rm -rf /" },
    });

    let count = 0;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        count++;
        return { status: "ok" as const, text: "should not happen" };
      },
    });

    expect(count).toBe(0);
    expect(result.status).toBe("blocked");
    expect(result.text).toBe("denylist entry 'rm' matched 'rm'");
  });
});

describe("HERAV1HRNS-TP01-TC-03: pending wait", () => {
  test("pending waits for resolve then dispatches (U13 pending→allow)", async () => {
    const plug = new ScriptedPlug([{ answer: "pending", resolveTo: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_4",
      kind: "tool.invoke",
      target: "ask_user",
      parameters: {},
    });

    let dispatched = false;
    const execPromise = gate.execute(descriptor, {
      dispatch: async () => { dispatched = true; return { status: "ok" as const, text: "ok" }; },
    });
    // Wait a tick to ensure pending is entered
    await Bun.sleep(50);
    expect(dispatched).toBe(false);
    // Resolve the pending
    gate.resolve(descriptor.effect_id);
    const result = await execPromise;

    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.end_prompt).toBe(false);
  }, 5000);

  test("pending waits for resolve then blocks (U13 pending→block)", async () => {
    const plug = new ScriptedPlug([{ answer: "pending", resolveTo: { answer: "block", reason: "test block" } }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_4b",
      kind: "tool.invoke",
      target: "ask_user",
      parameters: {},
    });

    const execPromise = gate.execute(descriptor, {
      dispatch: async () => ({ status: "ok" as const, text: "should not happen" }),
    });
    await Bun.sleep(50);
    gate.resolve(descriptor.effect_id);
    const result = await execPromise;

    expect(result.status).toBe("blocked");
    expect(result.end_prompt).toBe(false);
  }, 5000);

  test("pending halted while waiting returns blocked with end_prompt (U13)", async () => {
    const plug = new ScriptedPlug([{ answer: "pending" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_4c",
      kind: "tool.invoke",
      target: "ask_user",
      parameters: {},
    });

    const execPromise = gate.execute(descriptor, {
      dispatch: async () => ({ status: "ok" as const, text: "should not happen" }),
    });
    await Bun.sleep(50);
    gate.halt("test cancel");
    const result = await execPromise;

    expect(result.status).toBe("blocked");
    expect(result.end_prompt).toBe(true);
  }, 5000);
});

describe("HERAV1HRNS-TP01-TC-05: unavailable ends the prompt", () => {
  test("unavailable returns end_prompt=true and no dispatch", async () => {
    const plug = new ScriptedPlug([{ answer: "unavailable" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_5",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });

    let dispatched = false;
    let unavailableEffectId: string | undefined;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "should not happen" };
      },
      onUnavailable: async (effect_id) => {
        unavailableEffectId = effect_id;
      },
    });

    expect(dispatched).toBe(false);
    expect(result.end_prompt).toBe(true);
    expect(result.status).toBe("blocked");
    expect(unavailableEffectId).toBe("fx_5");
  });
});

describe("HERAV1HRNS-TP01-TC-14: descriptor shape", () => {
  test("descriptor has all required fields", () => {
    const d = new EffectDescriptor({
      effect_id: "fx_6",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { path: "/tmp/test.txt" },
      origin_refs: ["msg_1"],
      run_ctx: new Uint8Array([1, 2, 3]),
      prompt_id: "prompt_abc",
    });

    expect(d.effect_id).toBe("fx_6");
    expect(d.kind).toBe("tool.invoke");
    expect(d.target).toBe("read_file");
    expect(d.parameters).toEqual({ path: "/tmp/test.txt" });
    expect(d.origin_refs).toEqual(["msg_1"]);
    expect(Array.from(d.run_ctx)).toEqual([1, 2, 3]);
    expect(d.prompt_id).toBe("prompt_abc");
  });

  test("all six effect kinds are valid", () => {
    const kinds: EffectDescriptor["kind"][] = [
      "tool.invoke",
      "model.invoke",
      "memory.write",
      "net.egress",
      "process.spawn",
      "agent.delegate",
    ];
    for (const kind of kinds) {
      const d = new EffectDescriptor({
        effect_id: `fx_${kind}`,
        kind,
        target: "test",
        parameters: {},
      });
      expect(d.kind).toBe(kind);
    }
  });

  test("hash() is lazy and cached", () => {
    const d = new EffectDescriptor({
      effect_id: "fx_7",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { path: "/tmp/test.txt" },
    });

    const h1 = d.hash();
    const h2 = d.hash();
    expect(h1).toBe(h2);
    expect(typeof h1).toBe("string");
    expect(h1.length).toBeGreaterThan(0);
  });

  test("context_digest() is lazy and cached", () => {
    const d = new EffectDescriptor({
      effect_id: "fx_8",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { path: "/tmp/test.txt" },
    });

    const c1 = d.context_digest();
    const c2 = d.context_digest();
    expect(c1).toBe(c2);
    expect(typeof c1).toBe("string");
  });

  test("descriptor is immutable after freeze()", () => {
    const d = new EffectDescriptor({
      effect_id: "fx_9",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { path: "/tmp/test.txt" },
    });

    expect(d.frozen).toBe(false);
    d.freeze();
    expect(d.frozen).toBe(true);
    expect(Object.isFrozen(d.parameters)).toBe(true);
  });

  test("a changed parameter is a new descriptor (verifyIntegrity)", async () => {
    const params: Record<string, unknown> = { path: "/tmp/test.txt" };
    const d = new EffectDescriptor({
      effect_id: "fx_10",
      kind: "tool.invoke",
      target: "read_file",
      parameters: params,
    });

    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);

    // Freeze the descriptor, then mutate a copy (simulating a changed parameter)
    d.freeze();
    const originalHash = d.hash();

    // Create a new descriptor with changed parameters
    const d2 = new EffectDescriptor({
      effect_id: "fx_10",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { path: "/tmp/different.txt" },
    });
    d2.freeze();

    // The two descriptors have different hashes
    expect(d2.hash()).not.toBe(originalHash);
  });
});

describe("HERAV1HRNS-TP01-TC-12: pass-through equivalence", () => {
  test("PassThroughPlug always allows", async () => {
    const plug = new PassThroughPlug();
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_11",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });

    const result = await gate.execute(descriptor, {
      dispatch: async () => ({ status: "ok" as const, text: "ok" }),
    });

    expect(result.status).toBe("ok");
    expect(result.text).toBe("ok");
    expect(result.end_prompt).toBe(false);
  });

  test("PassThroughPlug admit returns run_ctx", () => {
    const plug = new PassThroughPlug();
    const result = plug.admit("hash", "plug_hash", 1);
    expect(result.admitted).toBe(true);
    if (result.admitted) {
      expect(result.run_ctx.length).toBe(16);
    }
  });
});

describe("HERAV1HRNS-TP01-TC-18: egress for model.invoke", () => {
  test("allow dispatches model.invoke via egress()", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_model",
      kind: "model.invoke",
      target: "generating",
      parameters: { role: "generating", model: "gpt-5.6" },
    });

    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "model output" };
    });

    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("model output");
    expect(result.end_prompt).toBe(false);
  });

  test("block on model.invoke prevents dispatch via egress()", async () => {
    const plug = new ScriptedPlug([
      { answer: { answer: "block", reason: "model blocked: quota exceeded" } },
    ]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_model_block",
      kind: "model.invoke",
      target: "supervisor",
      parameters: { role: "supervisor" },
    });

    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "should not happen" };
    });

    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("quota exceeded");
  });
});

describe("HERAV1HRNS-TP01-TC-19: egress for net.egress", () => {
  test("allow dispatches net.egress via egress()", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_net",
      kind: "net.egress",
      target: "https://api.example.com",
      parameters: { host: "api.example.com" },
    });

    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "response body" };
    });

    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("response body");
  });

  test("block on net.egress prevents dispatch", async () => {
    const plug = new ScriptedPlug([
      { answer: { answer: "block", reason: "egress blocked: host not allowed" } },
    ]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_net_block",
      kind: "net.egress",
      target: "https://evil.example.com",
      parameters: { host: "evil.example.com" },
    });

    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "should not happen" };
    });

    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("host not allowed");
  });
});

describe("HERAV1HRNS-TP01-TC-20: egress for process.spawn", () => {
  test("allow dispatches process.spawn via egress()", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_spawn",
      kind: "process.spawn",
      target: "run_command",
      parameters: { command: "pwsh -Command Get-Location", cwd: "/tmp" },
    });

    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "output" };
    });

    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
  });

  test("block on process.spawn prevents dispatch (denylist)", async () => {
    const plug = new ScriptedPlug([
      { answer: { answer: "block", reason: "denylist entry 'rm' matched 'rm'" } },
    ]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_spawn_block",
      kind: "process.spawn",
      target: "run_command",
      parameters: { command: "rm -rf /", cwd: "/tmp" },
    });

    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "should not happen" };
    });

    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("denylist");
  });
});

describe("HERAV1HRNS-TP01-TC-21: egress for memory.write", () => {
  test("allow dispatches memory.write via egress()", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_mem",
      kind: "memory.write",
      target: "memory-store",
      parameters: { text: "user prefers dark mode", scope: "workspace" },
    });

    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "stored" };
    });

    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("stored");
  });

  test("block on memory.write prevents dispatch", async () => {
    const plug = new ScriptedPlug([
      { answer: { answer: "block", reason: "memory write blocked: store full" } },
    ]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_mem_block",
      kind: "memory.write",
      target: "memory-store",
      parameters: { text: "candidate", scope: "workspace" },
    });

    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "should not happen" };
    });

    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("store full");
  });

  test("unavailable on memory.write ends the prompt via egress()", async () => {
    const plug = new ScriptedPlug([{ answer: "unavailable" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_mem_unavail_unit",
      kind: "memory.write",
      target: "memory-store",
      parameters: { text: "candidate", scope: "workspace" },
    });

    let dispatched = false;
    const result = await gate.egress(descriptor, async () => {
      dispatched = true;
      return { status: "ok" as const, text: "should not happen" };
    });

    expect(dispatched).toBe(false);
    expect(result.end_prompt).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("WARNING");
  });
});

describe("HERAV1HRNS-TP01-TC-16: resolve with decision parameter", () => {
  test("resolve(effect_id, 'allow') passes decision to provider and unblocks pending", async () => {
    const plug = new ScriptedPlug([{ answer: "pending", resolveTo: "allow" }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_decision_allow",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello" },
    });

    let dispatched = false;
    const executePromise = gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "done" };
      },
    });

    // Wait for pending state, then resolve with allow
    await new Promise((r) => setTimeout(r, 50));
    gate.resolve("fx_decision_allow", "allow");
    const result = await executePromise;

    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
  });

  test("resolve(effect_id, 'deny') passes decision to provider and blocks", async () => {
    const plug = new ScriptedPlug([{ answer: "pending", resolveTo: { answer: "block", reason: "denied by user" } }]);
    const gate = new Gate(plug);
    const descriptor = new EffectDescriptor({
      effect_id: "fx_decision_deny",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello" },
    });

    let dispatched = false;
    const executePromise = gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "done" };
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    gate.resolve("fx_decision_deny", "deny");
    const result = await executePromise;

    expect(dispatched).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.text).toContain("denied by user");
  });
});
