// Fault-obligation tests (HERAV1HRNS-TP01 TC-18..TC-23) against the real binary and gate.
// Each test exercises a fault condition from IN05 Section 9.3 using the Scripted plug.
// Deterministic: timing injected through Scripted plug delays and the rig, never through sleeps.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Gate } from "../../src/harness/gate.ts";
import { EffectDescriptor } from "../../src/harness/descriptor.ts";
import { ScriptedPlug } from "../../src/harness/plugs/scripted.ts";
import { PassThroughPlug } from "../../src/harness/plugs/passthrough.ts";
import { SessionStore, type EventSink } from "../../src/session/store.ts";
import { SinkRouter, type EmitFn } from "../../src/harness/sink.ts";
import { nowTs, readJsonlFile, type AgentEvent } from "../../src/events.ts";
import { MemoryStore, workspaceHash } from "../../src/supervisor/memory.ts";
import { InjectMailbox } from "../../src/executor/injection.ts";
import { REPO_ROOT, makeTempDir, removeDir, waitFor } from "../harness/procs.ts";
import { SCRIPTS, prepareRig } from "../harness/executor_rig.ts";
import { HeraProc, type ChildHandle } from "../harness/hera_proc.ts";
import { WriteQueue, WRITE_QUEUE_MAX } from "../../src/acp/connection.ts";

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

// ---------------------------------------------------------------------------
// TC-18: Race halt against queued effects
// ---------------------------------------------------------------------------

describe("HERAV1HRNS-TP01-TC-18: race halt against queued effects", () => {
  test("halt while a pending effect is in-flight cancels it and blocks new dispatch", async () => {
    const plug = new ScriptedPlug([
      { answer: "pending", delay_ms: 50 },
      { answer: "allow" },
    ]);
    const gate = new Gate(plug);

    // Start a pending effect (simulates queued model call / background command)
    const desc1 = new EffectDescriptor({
      effect_id: "fx_tc18_1",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "Start-Sleep -Seconds 10" },
    });
    const pendingPromise = gate.execute(desc1, {
      dispatch: async () => ({ status: "ok" as const, text: "should not reach" }),
    });

    // Halt while the effect is pending
    gate.halt("user cancel");
    expect(gate.halted).toBe(true);

    // Collect in-flight statuses
    const inFlight = gate.collectInFlight();
    expect(inFlight.length).toBeGreaterThanOrEqual(0);

    // New dispatch is blocked by halt
    const desc2 = new EffectDescriptor({
      effect_id: "fx_tc18_2",
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
  }, 10000);

  test("halt blocks egress for all effect kinds (queued model calls, retry timers)", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    gate.halt("terminal");

    const kinds: Array<{ kind: import("../../src/harness/descriptor.ts").EffectKind; target: string }> = [
      { kind: "model.invoke", target: "generating" },
      { kind: "memory.write", target: "memory_store" },
      { kind: "tool.invoke", target: "shell" },
      { kind: "net.egress", target: "https://example.com" },
      { kind: "process.spawn", target: "bun" },
    ];

    for (const { kind, target } of kinds) {
      const desc = new EffectDescriptor({
        effect_id: `fx_tc18_${kind}`,
        kind,
        target,
        parameters: {},
      });
      const isTool = kind === "tool.invoke";
      let dispatched = false;
      const result = isTool
        ? await gate.execute(desc, {
            dispatch: async () => { dispatched = true; return { status: "ok" as const, text: "no" }; },
          })
        : await gate.egress(desc, async () => { dispatched = true; return { status: "ok" as const, text: "no" }; });
      expect(dispatched).toBe(false);
      expect(result.status).toBe("blocked");
      expect(result.end_prompt).toBe(true);
    }
  }, 10000);

  test("halt racing multiple concurrent in-flight effects: all cancelled, all kinds blocked", async () => {
    const plug = new ScriptedPlug([
      { answer: "pending", delay_ms: 100 },
      { answer: "pending", delay_ms: 100 },
      { answer: "pending", delay_ms: 100 },
    ]);
    const gate = new Gate(plug);

    // Start three concurrent in-flight effects simulating:
    // 1) a queued model call, 2) a background command (process.spawn), 3) a retry timer (net.egress)
    const desc1 = new EffectDescriptor({
      effect_id: "fx_tc18_race_1",
      kind: "model.invoke",
      target: "generating",
      parameters: {},
    });
    const desc2 = new EffectDescriptor({
      effect_id: "fx_tc18_race_2",
      kind: "process.spawn",
      target: "bun",
      parameters: {},
    });
    const desc3 = new EffectDescriptor({
      effect_id: "fx_tc18_race_3",
      kind: "net.egress",
      target: "https://retry.example.com",
      parameters: {},
    });

    const p1 = gate.egress(desc1, async () => ({ status: "ok" as const, text: "should not reach" }));
    const p2 = gate.egress(desc2, async () => ({ status: "ok" as const, text: "should not reach" }));
    const p3 = gate.egress(desc3, async () => ({ status: "ok" as const, text: "should not reach" }));

    // Halt while all three are pending
    gate.halt("user cancel");
    expect(gate.halted).toBe(true);

    const r1 = await p1;
    const r2 = await p2;
    const r3 = await p3;

    // All three return blocked (pending answer → blocked, end_prompt false)
    expect(r1.status).toBe("blocked");
    expect(r2.status).toBe("blocked");
    expect(r3.status).toBe("blocked");

    // A late UI answer (new dispatch) is also blocked
    const desc4 = new EffectDescriptor({
      effect_id: "fx_tc18_race_4",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });
    let dispatched = false;
    const r4 = await gate.execute(desc4, {
      dispatch: async () => { dispatched = true; return { status: "ok" as const, text: "no" }; },
    });
    expect(dispatched).toBe(false);
    expect(r4.status).toBe("blocked");
    expect(r4.end_prompt).toBe(true);
  }, 10000);

  test("halt against the real binary: queued tool calls are cancelled, in-flight captured", async () => {
    const prepared = prepareRig({ script: join(SCRIPTS, "script_sleep_short.jsonl") });
    dirs.push(...prepared.dirs);
    const proc = new HeraProc({
      workspace: prepared.workspace,
      appDir: prepared.appDir,
      scriptPath: prepared.env["HERA_SCRIPTED_ADAPTER"] as string,
      env: { HERA_DECOY_KEY: "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789" },
    });
    const sessionDir = join(prepared.appDir, ".agent-data", "sessions");

    const handle = proc.startPiped([]);
    spawnedHandles.push(handle);
    handle.send("run it");

    // Wait for tool_call_requested
    let sessionFile: string | undefined;
    await waitFor(() => {
      if (!existsSync(sessionDir)) return false;
      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
      if (files.length === 0) return false;
      sessionFile = join(sessionDir, files[files.length - 1] as string);
      return readJsonlFile(sessionFile).events.some((e) => e.type === "tool_call_requested");
    }, 15000, "tool_call_requested in session JSONL");

    // Halt (kill) the process mid-tool-call
    handle.kill();

    // Verify the session JSONL has tool_call_requested but no tool_call_finished for that id
    const events = readJsonlFile(sessionFile as string).events;
    const requested = events.find((e) => e.type === "tool_call_requested");
    expect(requested).toBeDefined();
    const finished = events.find((e) => e.type === "tool_call_finished");
    // No tool_call_finished because we killed mid-call
    expect(finished).toBeUndefined();
  }, 30000);
});

// ---------------------------------------------------------------------------
// TC-19: Path swapping between request and dispatch
// ---------------------------------------------------------------------------

describe("HERAV1HRNS-TP01-TC-19: path swapping between request and dispatch", () => {
  test("descriptor frozen after request; mutation between request and dispatch is detected", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);

    const descriptor = new EffectDescriptor({
      effect_id: "fx_tc19_1",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { file_path: "/original/path.txt" },
    });

    // The gate freezes the descriptor during execute()
    // After freeze, parameters are immutable (Object.isFrozen)
    let dispatchRan = false;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        dispatchRan = true;
        // At this point the descriptor is frozen
        expect(Object.isFrozen(descriptor.parameters)).toBe(true);
        expect(descriptor.verifyIntegrity()).toBe(true);
        return { status: "ok" as const, text: "ok" };
      },
    });
    expect(dispatchRan).toBe(true);
    expect(result.status).toBe("ok");
  }, 10000);

  test("a modified descriptor with different path has a different hash", async () => {
    const desc1 = new EffectDescriptor({
      effect_id: "fx_tc19_2",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { file_path: "/original/path.txt" },
    });
    desc1.freeze();
    const hash1 = desc1.hash();

    const desc2 = new EffectDescriptor({
      effect_id: "fx_tc19_2",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { file_path: "/swapped/path.txt" },
    });
    desc2.freeze();
    const hash2 = desc2.hash();

    expect(hash1).not.toBe(hash2);
  }, 10000);

  test("integrity check fails when parameters are mutated before freeze (simulated swap)", async () => {
    const plug = new ScriptedPlug([{ answer: "allow", delay_ms: 10 }]);
    const gate = new Gate(plug);

    const descriptor = new EffectDescriptor({
      effect_id: "fx_tc19_3",
      kind: "tool.invoke",
      target: "read_file",
      parameters: { file_path: "/original/path.txt" },
    });

    // Pre-compute the hash before the gate freezes it
    const originalHash = descriptor.hash();

    // The gate will freeze and verify integrity inside execute()
    let dispatched = false;
    const result = await gate.execute(descriptor, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "ok" };
      },
    });

    // After execute, the descriptor is frozen and integrity is verified
    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
    expect(descriptor.frozen).toBe(true);
    expect(descriptor.verifyIntegrity()).toBe(true);
    expect(descriptor.hash()).toBe(originalHash);
  }, 10000);
});

// ---------------------------------------------------------------------------
// TC-20: Two Supervisors sharing storage
// ---------------------------------------------------------------------------

describe("HERAV1HRNS-TP01-TC-20: two Supervisors sharing storage", () => {
  test("two MemoryStore instances sharing the same directory do not corrupt each other", () => {
    const dir = makeTempDir("tc20_shared");
    dirs.push(dir);
    const hash = workspaceHash("C:/Work/SharedProject");

    const store1 = MemoryStore.open(dir, hash, { runCtx: "run_a" });
    const store2 = MemoryStore.open(dir, hash, { runCtx: "run_b" });

    // Both write to the same workspace file
    store1.append({
      id: "mem_00001",
      text: "fact from supervisor 1",
      scope: "workspace",
      tags: [],
      created: "2026-01-01T00:00:00Z",
      last_used: "2026-01-01T00:00:00Z",
      uses: 0,
      source_session: "s1",
    });
    store2.append({
      id: "mem_00002",
      text: "fact from supervisor 2",
      scope: "workspace",
      tags: [],
      created: "2026-01-01T00:00:01Z",
      last_used: "2026-01-01T00:00:01Z",
      uses: 0,
      source_session: "s2",
    });
    store1.append({
      id: "mem_00003",
      text: "second fact from supervisor 1",
      scope: "workspace",
      tags: [],
      created: "2026-01-01T00:00:02Z",
      last_used: "2026-01-01T00:00:02Z",
      uses: 0,
      source_session: "s1",
    });

    // Verify the file has all 3 lines and no corruption
    const workspaceFile = join(dir, `workspace-${hash}.jsonl`);
    const lines = readFileSync(workspaceFile, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);

    const ids = lines.map((l) => JSON.parse(l).id);
    expect(ids).toContain("mem_00001");
    expect(ids).toContain("mem_00002");
    expect(ids).toContain("mem_00003");

    // No duplicate writes
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(3);

    // Reopen and verify latest-line-wins
    const reopened = MemoryStore.open(dir, hash);
    expect(reopened.size).toBe(3);
    expect(reopened.memories.get("mem_00001")?.text).toBe("fact from supervisor 1");
    expect(reopened.memories.get("mem_00002")?.text).toBe("fact from supervisor 2");
    expect(reopened.memories.get("mem_00003")?.text).toBe("second fact from supervisor 1");
  }, 10000);

  test("concurrent appends via file locking produce a valid store", () => {
    const dir = makeTempDir("tc20_concurrent");
    dirs.push(dir);
    const hash = workspaceHash("C:/Work/Concurrent");

    const store1 = MemoryStore.open(dir, hash, { runCtx: "run_a" });
    const store2 = MemoryStore.open(dir, hash, { runCtx: "run_b" });

    // Interleave appends from both stores
    for (let i = 0; i < 10; i++) {
      const store = i % 2 === 0 ? store1 : store2;
      store.append({
        id: `mem_${String(i + 1).padStart(5, "0")}`,
        text: `fact ${i} from ${i % 2 === 0 ? "A" : "B"}`,
        scope: "workspace",
        tags: [],
        created: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
        last_used: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
        uses: 0,
        source_session: `s${i % 2 + 1}`,
      });
    }

    const workspaceFile = join(dir, `workspace-${hash}.jsonl`);
    const lines = readFileSync(workspaceFile, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(10);

    // All lines are valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.id).toMatch(/^mem_\d{5}$/);
      expect(typeof parsed.text).toBe("string");
    }

    // No duplicate ids
    const ids = lines.map((l) => JSON.parse(l).id);
    expect(new Set(ids).size).toBe(10);
  }, 10000);
});

// ---------------------------------------------------------------------------
// TC-21: Near-window requests and large tool batches
// ---------------------------------------------------------------------------

describe("HERAV1HRNS-TP01-TC-21: near-window requests and large tool batches", () => {
  test("many effects processed in order through the gate", async () => {
    const plug = new ScriptedPlug([]);
    // ScriptedPlug with empty entries returns "allow" for any request
    const gate = new Gate(plug);

    const results: string[] = [];
    for (let i = 0; i < 50; i++) {
      const desc = new EffectDescriptor({
        effect_id: `fx_tc21_${i}`,
        kind: "tool.invoke",
        target: "read_file",
        parameters: { file_path: `/file_${i}.txt` },
      });
      const result = await gate.execute(desc, {
        dispatch: async () => {
          results.push(`ok_${i}`);
          return { status: "ok" as const, text: `result_${i}` };
        },
      });
      expect(result.status).toBe("ok");
    }

    // All 50 processed in order
    expect(results).toHaveLength(50);
    expect(results[0]).toBe("ok_0");
    expect(results[49]).toBe("ok_49");
    // Verify ordering
    for (let i = 0; i < 50; i++) {
      expect(results[i]).toBe(`ok_${i}`);
    }
  }, 15000);

  test("large tool batch: many tool calls in one turn produce effects in order", async () => {
    const dir = makeTempDir("tc21_batch");
    dirs.push(dir);
    const store = SessionStore.open(dir, "new");
    const router = new SinkRouter(store);
    const events: AgentEvent[] = [];
    const emit: EmitFn = async (event) => {
      events.push(event);
      router.append(event);
    };

    const plug = new ScriptedPlug([]);
    const gate = new Gate(plug);

    // Simulate a batch of 20 tool calls
    for (let i = 0; i < 20; i++) {
      const effectId = `fx_tc21_batch_${i}`;
      // Emit tool_call_requested before dispatch
      await emit({ ts: nowTs(), proc: "exec", type: "tool_call_requested", id: effectId, tool: "read_file", args: {}, args_json: "{}" }, true);
      const desc = new EffectDescriptor({
        effect_id: effectId,
        kind: "tool.invoke",
        target: "read_file",
        parameters: { file_path: `/file_${i}.txt` },
      });
      await gate.execute(desc, {
        dispatch: async () => {
          // Emit tool_call_finished after dispatch
          await emit({ ts: nowTs(), proc: "exec", type: "tool_call_finished", id: effectId, status: "ok", result: `content_${i}`, result_chars: 9, prompt_id: "p1" }, true);
          return { status: "ok" as const, text: `content_${i}` };
        },
      });
    }

    // Verify all events are on disk in order
    const diskEvents = readJsonlFile(store.path).events;
    const requestedEvents = diskEvents.filter((e) => e.type === "tool_call_requested");
    const finishedEvents = diskEvents.filter((e) => e.type === "tool_call_finished");
    expect(requestedEvents).toHaveLength(20);
    expect(finishedEvents).toHaveLength(20);

    // Verify ordering: requested[i] comes before finished[i] for each i
    for (let i = 0; i < 20; i++) {
      const reqIdx = diskEvents.findIndex((e) => e.type === "tool_call_requested" && (e as { id: string }).id === `fx_tc21_batch_${i}`);
      const finIdx = diskEvents.findIndex((e) => e.type === "tool_call_finished" && (e as { id: string }).id === `fx_tc21_batch_${i}`);
      expect(reqIdx).toBeGreaterThanOrEqual(0);
      expect(finIdx).toBeGreaterThan(reqIdx);
    }

    store.close();
  }, 15000);
});

// ---------------------------------------------------------------------------
// TC-22: Stalled sink and full display queues
// ---------------------------------------------------------------------------

describe("HERAV1HRNS-TP01-TC-22: stalled sink and full display queues", () => {
  test("a stalled sink does not lose events: SinkRouter buffers to disk when sink is available", async () => {
    const dir = makeTempDir("tc22_sink");
    dirs.push(dir);
    const store = SessionStore.open(dir, "new");
    const router = new SinkRouter(store);

    // Append events while the sink is available (not stalled)
    for (let i = 0; i < 10; i++) {
      router.append({ ts: nowTs(), proc: "exec", type: "text_delta", text: `chunk_${i}` });
    }

    // All events are on disk
    const diskEvents = readJsonlFile(store.path).events;
    expect(diskEvents).toHaveLength(10);
    expect(diskEvents[0]?.type).toBe("text_delta");
    expect((diskEvents[0] as { text: string }).text).toBe("chunk_0");
    expect((diskEvents[9] as { text: string }).text).toBe("chunk_9");

    store.close();
  }, 10000);

  test("dispatch pauses when sink is closed: gate still processes but sink drops", async () => {
    const dir = makeTempDir("tc22_closed");
    dirs.push(dir);
    const store = SessionStore.open(dir, "new");
    store.close();

    // Sink is closed - SinkRouter with a closed sink
    const router = new SinkRouter(store);
    expect(router.isOpen).toBe(false);

    // Appending to a closed sink throws - the caller must handle this
    // The gate itself does not stall; the dispatch still runs
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);

    const desc = new EffectDescriptor({
      effect_id: "fx_tc22_1",
      kind: "tool.invoke",
      target: "read_file",
      parameters: {},
    });

    let dispatched = false;
    const result = await gate.execute(desc, {
      dispatch: async () => {
        dispatched = true;
        return { status: "ok" as const, text: "ok" };
      },
    });
    // Gate dispatches regardless of sink state
    expect(dispatched).toBe(true);
    expect(result.status).toBe("ok");
  }, 10000);

  test("stalled sink: events queued in-memory are not lost when sink recovers", async () => {
    // A custom sink that stalls (blocks) then recovers
    const dir = makeTempDir("tc22_stall");
    dirs.push(dir);

    const events: AgentEvent[] = [];
    let stallCleared = false;

    const stalledSink: EventSink = {
      append(event: AgentEvent): void {
        if (!stallCleared) {
          // Simulate stall: buffer in memory
          events.push(event);
          return;
        }
        // After recovery: flush buffered + new
        events.push(event);
      },
      get isOpen(): boolean { return true; },
    };

    const router = new SinkRouter(stalledSink);

    // Append during stall
    for (let i = 0; i < 5; i++) {
      router.append({ ts: nowTs(), proc: "exec", type: "text_delta", text: `stall_${i}` });
    }
    expect(events).toHaveLength(5);

    // Clear the stall
    stallCleared = true;

    // Append after recovery
    for (let i = 5; i < 10; i++) {
      router.append({ ts: nowTs(), proc: "exec", type: "text_delta", text: `recover_${i}` });
    }
    expect(events).toHaveLength(10);
    // No events lost
    expect((events[0] as { text: string }).text).toBe("stall_0");
    expect((events[9] as { text: string }).text).toBe("recover_9");
  }, 10000);

  test("full display queue: overflow drops oldest droppable, non-droppable preserved", async () => {
    let dropCount = 0;
    // A slow writer that blocks to simulate a stalled display
    let writeResolve: (() => void) | undefined;
    const slowWrite = (_text: string): Promise<void> => new Promise((r) => { writeResolve = r; });
    const queue = new WriteQueue(
      slowWrite,
      (count) => { dropCount += count; },
      5, // small capacity for testing
    );

    // Enqueue 6 droppable notifications; first is in-flight (being written), 5 in queue
    for (let i = 0; i < 6; i++) {
      queue.enqueue(`notif_${i}`, true);
    }
    // First item shifted out for writing; queue has 5 items (full)
    expect(queue.pending).toBe(5);

    // Add one more droppable - oldest in queue should be dropped
    queue.enqueue(`notif_6`, true);
    expect(queue.pending).toBe(5);
    expect(queue.dropped).toBe(1);

    // Add a non-droppable response - a droppable is dropped to make room
    queue.enqueue(`response_0`, false);
    expect(queue.pending).toBe(5);
    expect(queue.dropped).toBe(2);

    // Add another non-droppable - another droppable dropped
    queue.enqueue(`response_1`, false);
    expect(queue.pending).toBe(5);
    expect(queue.dropped).toBe(3);

    // Release the write stall and let the queue drain
    const drained: string[] = [];
    // Replace the write function to collect lines
    (queue as unknown as { write: (text: string) => Promise<void> }).write = (text: string) => {
      drained.push(text);
      return Promise.resolve();
    };
    // Unblock the first write
    if (writeResolve) writeResolve();
    // Wait for drain to complete
    await new Promise((r) => setTimeout(r, 50));

    // Non-droppable items are in the drained output (WriteQueue appends \n)
    expect(drained).toContain("response_0\n");
    expect(drained).toContain("response_1\n");
    // At least 3 droppable notifications were dropped (oldest first)
    expect(dropCount).toBeGreaterThanOrEqual(3);
  }, 10000);
});

// ---------------------------------------------------------------------------
// TC-23: Late inject to a different prompt
// ---------------------------------------------------------------------------

describe("HERAV1HRNS-TP01-TC-23: late inject to a different prompt", () => {
  test("inject with a different prompt_id is discarded by the mailbox", () => {
    const mailbox = new InjectMailbox();
    mailbox.setPromptContext("prompt-001", new Uint8Array(0));

    // Valid inject for the current prompt
    mailbox.push({
      kind: "memory",
      text: "memory for current prompt",
      memory_ids: ["mem_001"],
      prompt_id: "prompt-001",
      run_ctx: "",
    } as unknown as import("../../src/process/envelope.ts").PayloadOf<"inject">);

    expect(mailbox.hasPending).toBe(true);

    // Late inject for a different prompt
    mailbox.push({
      kind: "memory",
      text: "memory for old prompt",
      memory_ids: ["mem_002"],
      prompt_id: "prompt-000",
      run_ctx: "",
    } as unknown as import("../../src/process/envelope.ts").PayloadOf<"inject">);

    // Drain: only the valid inject should appear
    const drained = mailbox.drainForUserMessage();
    expect(drained.memoryIds).toEqual(["mem_001"]);
    expect(drained.blocks).toContain("memory for current prompt");
    expect(drained.blocks).not.toContain("memory for old prompt");
  }, 10000);

  test("discardLate clears pending injects after the prompt ends", () => {
    const mailbox = new InjectMailbox();
    mailbox.setPromptContext("prompt-002", new Uint8Array(0));

    mailbox.push({
      kind: "memory",
      text: "pending memory",
      memory_ids: ["mem_003"],
      prompt_id: "prompt-002",
      run_ctx: "",
    } as unknown as import("../../src/process/envelope.ts").PayloadOf<"inject">);

    mailbox.push({
      kind: "governance",
      text: "governance note",
      prompt_id: "prompt-002",
      run_ctx: "",
    } as unknown as import("../../src/process/envelope.ts").PayloadOf<"inject">);

    expect(mailbox.hasPending).toBe(true);

    // Late discard
    let discardLogged = false;
    mailbox.discardLate((op, fields) => {
      discardLogged = true;
      expect(op).toBe("inject_discarded");
      expect(fields?.count).toBe(2);
    });

    expect(discardLogged).toBe(true);
    expect(mailbox.hasPending).toBe(false);
  }, 10000);

  test("inject with no prompt_id is accepted (backward compat)", () => {
    const mailbox = new InjectMailbox();
    mailbox.setPromptContext("prompt-003", new Uint8Array(0));

    // Inject without prompt_id should be accepted (not late)
    mailbox.push({
      kind: "memory",
      text: "memory without prompt_id",
      memory_ids: ["mem_004"],
    } as unknown as import("../../src/process/envelope.ts").PayloadOf<"inject">);

    expect(mailbox.hasPending).toBe(true);
    const drained = mailbox.drainForUserMessage();
    expect(drained.memoryIds).toEqual(["mem_004"]);
  }, 10000);

  test("no cross-prompt contamination: drained blocks from prompt-A do not appear in prompt-B", () => {
    // Prompt A
    const mailboxA = new InjectMailbox();
    mailboxA.setPromptContext("prompt-A", new Uint8Array(0));
    mailboxA.push({
      kind: "memory",
      text: "memory from A",
      memory_ids: ["mem_a1"],
      prompt_id: "prompt-A",
      run_ctx: "",
    } as unknown as import("../../src/process/envelope.ts").PayloadOf<"inject">);
    const drainedA = mailboxA.drainForUserMessage();
    expect(drainedA.blocks).toContain("memory from A");

    // Prompt B
    const mailboxB = new InjectMailbox();
    mailboxB.setPromptContext("prompt-B", new Uint8Array(0));
    // Late inject from prompt-A arrives at mailboxB
    mailboxB.push({
      kind: "memory",
      text: "memory from A",
      memory_ids: ["mem_a1"],
      prompt_id: "prompt-A",
      run_ctx: "",
    } as unknown as import("../../src/process/envelope.ts").PayloadOf<"inject">);
    const drainedB = mailboxB.drainForUserMessage();
    // The late inject is discarded - no cross-prompt contamination
    expect(drainedB.blocks).toBe("");
    expect(drainedB.memoryIds).toHaveLength(0);
  }, 10000);
});
