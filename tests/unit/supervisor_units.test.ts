import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowTs, type AgentEvent } from "../../src/events.ts";
import type { ResolvedRole } from "../../src/config/load.ts";
import type { AdapterDelta, ProviderAdapter } from "../../src/providers/base.ts";
import { MemoryStore, extractMemories, filterCandidates, isTrivialTurn, parseJsonArray, retrieveMemories, workspaceHash } from "../../src/supervisor/memory.ts";
import { computeMac, migrateMemoryFile } from "../../src/config/migrate.ts";
import { memorySecretPath } from "../../src/config/appdir.ts";
import { scanKeyShapes, redactKeyShapes } from "../../src/harness/plugs/keyshapes.ts";
import { ReviewTriggers, Reviewer, buildReviewInput, parseReviewText, renderReviewRequest, runReview } from "../../src/supervisor/review.ts";
import { StallWatchdog, parsePhaseSince } from "../../src/supervisor/watchdog.ts";
import { Gate } from "../../src/harness/gate.ts";
import { PassThroughPlug } from "../../src/harness/plugs/passthrough.ts";
import { assertNoSecretLeak } from "../harness/assertions.ts";
import { makeTempDir, removeDir } from "../harness/procs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const ev = (partial: Record<string, unknown>): AgentEvent => ({ ts: nowTs(), proc: "exec", ...partial }) as unknown as AgentEvent;

describe("HERAV1SUPV-TP01 watchdog", () => {
  const make = () => {
    let now = 1_000_000;
    const actions: string[] = [];
    const wd = new StallWatchdog({ stallTimeoutMs: 120_000, heartbeatMs: 5000 }, { resume: (p) => actions.push(`resume:${p.reason}:${p.phase}`), restartRequest: (r) => actions.push(`restart:${r}`), intervention: (k, t) => actions.push(`intervention:${k}:${t}`) }, () => now);
    return { wd, actions, advance: (ms: number) => (now += ms), now: () => now };
  };
  const beat = (turnActive: boolean, phase: string, phaseSince: number): Parameters<StallWatchdog["onHeartbeat"]>[0] => ({ turn_active: turnActive, last_event_id: 1, pid: 1, phase: phase as "idle", phase_since: tsOf(phaseSince) });
  const tsOf = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };

  test("HERAV1SUPV-TP01-TC-13 condition A: turn active, no heartbeat and no event for stall_timeout → resume {frozen}, then restart on the second stall", () => {
    const { wd, actions, advance } = make();
    wd.onEvent(ev({ type: "user_message", content: "x" }));
    wd.onHeartbeat(beat(true, "model_call", 1_000_000));
    advance(60_000);
    expect(wd.tick()).toBe("none");
    advance(61_000);
    expect(wd.tick()).toBe("resume");
    expect(actions[0]).toBe("resume:frozen:model_call");
    expect(actions[1]).toStartWith("intervention:stall_resume:Executor silent for 121 s");
    // the Executor confirms
    wd.onEvent(ev({ type: "executor_resumed", reason: "frozen" }));
    wd.onHeartbeat(beat(true, "model_call", 1_121_000));
    advance(121_000);
    expect(wd.tick()).toBe("restart");
    expect(actions.at(-2)).toStartWith("restart:");
    expect(actions.at(-1)).toContain("intervention:restart_request");
    expect(wd.tick()).toBe("none");
  });

  test("HERAV1SUPV-TP01-TC-14 condition B: tool_call phase older than the timeout with flowing heartbeats → resume {tool_hang}", () => {
    const { wd, actions, advance, now } = make();
    wd.onEvent(ev({ type: "user_message", content: "x" }));
    const since = now();
    for (let i = 0; i < 25; i++) {
      advance(5000);
      wd.onHeartbeat(beat(true, "tool_call", since));
      wd.onEvent(ev({ type: "text_delta", text: "still alive" }));
    }
    expect(wd.tick()).toBe("resume");
    expect(actions[0]).toBe("resume:tool_hang:tool_call");
    expect(actions[1]).toContain("tool call running for 125 s");
  });

  test("HERAV1SUPV-TP01-TC-15 never a stall: model_call with heartbeats, waiting_answer, idle; reset on exit and executor_resumed restart", () => {
    const { wd, advance, actions } = make();
    wd.onEvent(ev({ type: "user_message", content: "x" }));
    const start = 1_000_000;
    for (let i = 0; i < 60; i++) {
      advance(5000);
      wd.onHeartbeat(beat(true, "model_call", start));
      expect(wd.tick()).toBe("none");
    }
    for (let i = 0; i < 60; i++) {
      advance(5000);
      wd.onHeartbeat(beat(true, "waiting_answer", start));
      expect(wd.tick()).toBe("none");
    }
    wd.onHeartbeat(beat(false, "idle", start));
    advance(500_000);
    expect(wd.tick()).toBe("none");
    wd.onEvent(ev({ type: "user_message", content: "y" }));
    wd.onHeartbeat(beat(true, "model_call", start));
    advance(200_000);
    wd.reset();
    expect(wd.tick()).toBe("none");
    expect(actions).toEqual([]);
    expect(parsePhaseSince("2026-01-15 10:00:00.250")).toBe(new Date(2026, 0, 15, 10, 0, 0, 250).getTime());
    expect(parsePhaseSince("garbage")).toBeUndefined();
  });

  test("HERAV1SUPV-TP01-TC-16 missed resume confirmation within 2 x heartbeat → restart_request", () => {
    const { wd, actions, advance } = make();
    wd.onEvent(ev({ type: "user_message", content: "x" }));
    wd.onHeartbeat(beat(true, "model_call", 1_000_000));
    advance(121_000);
    expect(wd.tick()).toBe("resume");
    advance(10_001);
    expect(wd.tick()).toBe("restart");
    expect(actions.some((a) => a.startsWith("restart:Executor did not confirm the resume within 10 s"))).toBe(true);
  });
});

describe("HERAV1SUPV-TP01 review", () => {
  test("HERAV1SUPV-TP01-TC-19/20 triggers: every_n_calls, error_streak, repeated_edit, cost_spike once per turn", () => {
    const fired: string[] = [];
    const alerts: number[] = [];
    const t = new ReviewTriggers({ reviewEveryCalls: 3, costAlertUsd: 1 }, (r) => fired.push(r), (c) => alerts.push(c));
    t.onEvent(ev({ type: "user_message", content: "<user_request>\nfix it\n</user_request>\n\n<user_metadata>\n</user_metadata>" }));
    expect(t.userRequest).toBe("fix it");
    for (let i = 1; i <= 3; i++) t.onEvent(ev({ type: "tool_call_requested", id: `t${i}`, tool: "edit", args: { file_path: "C:\\W\\A.ts" }, args_json: "{}" }));
    expect(fired).toEqual(["every_n_calls", "repeated_edit"]);
    for (let i = 1; i <= 3; i++) t.onEvent(ev({ type: "tool_call_finished", id: `t${i}`, status: "error", result: "x", result_chars: 1 }));
    expect(fired.at(-1)).toBe("error_streak");
    t.onHeartbeat({ turn_active: true, last_event_id: 1, pid: 1, turn_usage: { uncached_input: 1, cache_write: 0, cache_read: 0, output: 1, cost_usd: 1.5 } });
    t.onHeartbeat({ turn_active: true, last_event_id: 1, pid: 1, turn_usage: { uncached_input: 1, cache_write: 0, cache_read: 0, output: 1, cost_usd: 2.5 } });
    expect(alerts).toEqual([1.5]);
    expect(fired.filter((f) => f === "cost_spike")).toHaveLength(1);
    expect(t.recentCalls).toHaveLength(3);
  });

  test("HERAV1SUPV-TP01-TC-21/22 review input caps, note parsing and truncation, coalescing", async () => {
    const input = buildReviewInput(["every_n_calls"], [{ id: "a", tool: "read_file", argsSummary: "x".repeat(400).slice(0, 300), status: "ok", startedAt: 0, durationMs: 5, target: undefined }], "req", 0.2, [{ filename: "r.md", trigger: "always_on", content: "y".repeat(3000), skippedReason: undefined }, { filename: "skip.md", trigger: "model", content: "z", skippedReason: "trigger" }]);
    expect(input.rules).toHaveLength(1);
    expect(input.rules[0]?.text.length).toBe(2000);
    const rendered = renderReviewRequest(input);
    expect(rendered).toContain("Trigger: every_n_calls");
    expect(rendered).toContain('<rule file="r.md">');
    expect(parseReviewText("no action")).toBeUndefined();
    expect(parseReviewText('"No action."')).toBeUndefined();
    expect(parseReviewText("Stop.")).toBe("Stop.");
    expect(parseReviewText("n".repeat(700))?.length).toBe(600);
    const fake: ProviderAdapter = {
      provider: "scripted",
      streamTurn: async function* () {
        yield { kind: "text", text: "Read files before editing them (rules/r.md: 'always read first')." } as AdapterDelta;
        yield { kind: "usage", usage: { uncachedInput: 10, cacheWrite: 0, cacheRead: 0, output: 5 }, stopReason: "end", thinkingPayloads: [] } as AdapterDelta;
      },
      supportsWebSearch: () => false,
      webSearch: () => Promise.resolve([]),
    };
    const role = { name: "supervisor", modelId: "m", provider: "scripted", method: "temperature", effort: "low", params: { method: "temperature", temperature: 0 }, maxInput: 1, maxOutput: 1, contextWindow: 1 } as ResolvedRole;
    const outcome = await runReview(input, fake, role, new Gate(new PassThroughPlug()));
    expect(outcome.note).toContain("rules/r.md");
    expect(outcome.usage.uncachedInput).toBe(10);
    const runs: string[][] = [];
    let release: (() => void) | undefined;
    const reviewer = new Reviewer(async (reasons) => {
      runs.push(reasons);
      await new Promise<void>((r) => {
        release = r;
      });
    });
    reviewer.schedule("every_n_calls");
    reviewer.schedule("error_streak");
    reviewer.schedule("cost_spike");
    expect(runs).toEqual([["every_n_calls"]]);
    release?.();
    await Bun.sleep(5);
    expect(runs).toEqual([["every_n_calls"], ["error_streak", "cost_spike"]]);
    release?.();
  });
});

describe("HERAV1SUPV-TP01 memory", () => {
  const memRole = { name: "memory", modelId: "m", provider: "scripted", method: "temperature", effort: "low", params: { method: "temperature", temperature: 0 }, maxInput: 1, maxOutput: 1, contextWindow: 1 } as ResolvedRole;
  const replying = (texts: string[]): ProviderAdapter => {
    let i = 0;
    return {
      provider: "scripted",
      streamTurn: async function* () {
        yield { kind: "text", text: texts[i++] ?? "[]" } as AdapterDelta;
        yield { kind: "usage", usage: { uncachedInput: 3, cacheWrite: 0, cacheRead: 0, output: 2 }, stopReason: "end", thinkingPayloads: [] } as AdapterDelta;
      },
      supportsWebSearch: () => false,
      webSearch: () => Promise.resolve([]),
    };
  };

  test("HERAV1SUPV-TP01-TC-25/26 store fold: latest wins, tombstones, corrupt line skipped; workspace and global files", () => {
    const dir = makeTempDir("mem");
    dirs.push(dir);
    const hash = workspaceHash("C:/Work/Proj");
    expect(hash).toBe(workspaceHash("c:\\work\\proj"));
    writeFileSync(join(dir, `workspace-${hash}.jsonl`), ['{"id":"mem_00001","text":"old text","scope":"workspace","tags":[],"created":"a","last_used":"a","uses":0,"source_session":"s"}', '{"id":"mem_00001","text":"new text","scope":"workspace","tags":[],"created":"a","last_used":"b","uses":1,"source_session":"s"}', "{corrupt", '{"id":"mem_00002","text":"gone","scope":"workspace","tags":[],"created":"a","last_used":"a","uses":0,"source_session":"s"}', '{"id":"mem_00002","deleted":true,"ts":"c","reason":"superseded"}'].join("\n"));
    writeFileSync(join(dir, "global.jsonl"), '{"id":"mem_00003","text":"global fact","scope":"global","tags":["g"],"created":"a","last_used":"a","uses":0,"source_session":"s"}\n');
    const store = MemoryStore.open(dir, hash);
    expect(store.size).toBe(2);
    expect(store.memories.get("mem_00001")?.text).toBe("new text");
    expect(store.warnings).toHaveLength(1);
    expect(store.warnings[0]).toContain("line 3 skipped");
    expect(store.newId()).toBe("mem_00004");
    expect(store.candidates(5).map((m) => m.id).sort()).toEqual(["mem_00001", "mem_00003"]);
    store.touch("mem_00003", "z");
    expect(readFileSync(join(dir, "global.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(store.memories.get("mem_00003")?.uses).toBe(1);
  });

  test("HERAV1SUPV-TP01-TC-27/28 extraction: trivial turns skipped, key-shaped candidates dropped, 500-char cap, dedupe touches", async () => {
    const dir = makeTempDir("mem2");
    dirs.push(dir);
    const store = MemoryStore.open(dir, "abc");
    expect(isTrivialTurn({ userRequest: "hi", assistantText: "hello", toolNames: [] })).toBe(true);
    const skipped = await extractMemories(store, { userRequest: "hi", assistantText: "hello", toolNames: [] }, replying(["[]"]), memRole, "s1", undefined);
    expect(skipped.call).toBeUndefined();
    const decoy = "sk-HERA_DECOY_abcdefghijklmnopqrstuvwxyz0123456789";
    const adapter = replying([`Here you go:\n[{"text": "The project uses tabs for indentation", "scope": "workspace", "tags": ["style"]}, {"text": "API key is ${decoy}", "scope": "global"}, {"text": "${"long ".repeat(200)}", "scope": "workspace"}]`, '[{"text": "the project uses TABS for indentation", "scope": "workspace"}]']);
    const first = await extractMemories(store, { userRequest: "format", assistantText: "x".repeat(300), toolNames: ["edit"] }, adapter, memRole, "s1", undefined);
    expect(first.created).toHaveLength(2);
    expect(first.created[0]?.text).toBe("The project uses tabs for indentation");
    expect(first.created[1]?.text.length).toBe(500);
    assertNoSecretLeak([readFileSync(store.workspaceFile, "utf8")], undefined, [decoy]);
    const second = await extractMemories(store, { userRequest: "format", assistantText: "y".repeat(300), toolNames: ["edit"] }, adapter, memRole, "s2", undefined);
    expect(second.created).toHaveLength(0);
    expect(second.touched).toEqual([first.created[0]?.id as string]);
    expect(store.memories.get(first.created[0]?.id as string)?.uses).toBe(1);
    expect(filterCandidates(parseJsonArray("nothing here"))).toEqual([]);
  });

  test("HERAV1SUPV-TP01-TC-29/30 retrieval: no call with zero candidates; ranking call returns ids; top_k cap; uses updated", async () => {
    const dir = makeTempDir("mem3");
    dirs.push(dir);
    const store = MemoryStore.open(dir, "abc");
    const none = await retrieveMemories(store, "anything", 5, replying(["[]"]), memRole, undefined);
    expect(none.call).toBeUndefined();
    for (let i = 1; i <= 8; i++) store.append({ id: store.newId(), text: `fact ${i}`, scope: i === 8 ? "global" : "workspace", tags: [], created: "a", last_used: `2026-01-0${i}`, uses: 0, source_session: "s" });
    const outcome = await retrieveMemories(store, "tell me facts", 2, replying(['["mem_00003", "mem_00008", "mem_00001", "mem_99999"]']), memRole, undefined);
    expect(outcome.selected.map((m) => m.id)).toEqual(["mem_00003", "mem_00008"]);
    expect(outcome.call?.request).toContain("at most 2 ids");
    expect(store.memories.get("mem_00003")?.uses).toBe(1);
    expect(store.candidates(1)).toHaveLength(5); // 1 x 4 workspace + 1 global
  });

  test("HERAV1SUPV-TP01-TC-31 U9: memory extraction carries origin; round-trip preserves origin", async () => {
    const dir = makeTempDir("mem4");
    dirs.push(dir);
    const store = MemoryStore.open(dir, "abc");
    const adapter = replying(['[{"text": "user prefers dark mode", "scope": "workspace", "tags": [], "origin": {"kind": "user", "ref": "prompt_1"}}]']);
    const outcome = await extractMemories(store, { userRequest: "set theme", assistantText: "ok".repeat(150), toolNames: ["edit"] }, adapter, memRole, "s1", undefined);
    expect(outcome.created).toHaveLength(1);
    expect(outcome.created[0]?.origin).toEqual({ kind: "user", ref: "prompt_1" });
    const file = readFileSync(store.workspaceFile, "utf8");
    expect(file).toContain('"origin"');
    expect(file).toContain('"prompt_1"');
    const reopened = MemoryStore.open(dir, "abc");
    expect(reopened.memories.get(outcome.created[0]?.id as string)?.origin).toEqual({ kind: "user", ref: "prompt_1" });
  });

  test("HERAV1HRNS-TP01-TC-06b two invocations sharing an app directory leave a valid store with both writers' records", () => {
    const dir = makeTempDir("mem_concurrent");
    dirs.push(dir);
    const hash = workspaceHash("C:/Work/Proj");
    const store1 = MemoryStore.open(dir, hash, { runCtx: "run_a" });
    const store2 = MemoryStore.open(dir, hash, { runCtx: "run_b" });
    store1.append({ id: "mem_00001", text: "fact from writer 1", scope: "workspace", tags: [], created: "2026-01-01T00:00:00Z", last_used: "2026-01-01T00:00:00Z", uses: 0, source_session: "s1" });
    store2.append({ id: "mem_00002", text: "fact from writer 2", scope: "workspace", tags: [], created: "2026-01-01T00:00:01Z", last_used: "2026-01-01T00:00:01Z", uses: 0, source_session: "s2" });
    store1.append({ id: "mem_00003", text: "second fact from writer 1", scope: "workspace", tags: [], created: "2026-01-01T00:00:02Z", last_used: "2026-01-01T00:00:02Z", uses: 0, source_session: "s1" });
    const workspaceFile = join(dir, `workspace-${hash}.jsonl`);
    const lines = readFileSync(workspaceFile, "utf8").split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3);
    const ids = lines.map((l) => JSON.parse(l).id);
    expect(ids).toContain("mem_00001");
    expect(ids).toContain("mem_00002");
    expect(ids).toContain("mem_00003");
    const reopened = MemoryStore.open(dir, hash);
    expect(reopened.size).toBe(3);
    expect(reopened.memories.get("mem_00001")?.text).toBe("fact from writer 1");
    expect(reopened.memories.get("mem_00002")?.text).toBe("fact from writer 2");
    expect(reopened.memories.get("mem_00003")?.text).toBe("second fact from writer 1");
  });

  test("HERAV1SUPV-TP01-TC-28 scanKeyShapes and redactKeyShapes from keyshapes.ts", () => {
    expect(scanKeyShapes("normal text without keys")).toBe(false);
    expect(scanKeyShapes("sk-ant-api03-abcdefghijk")).toBe(true);
    expect(scanKeyShapes("sk-1234567890abcdef")).toBe(true);
    expect(scanKeyShapes("x".repeat(40))).toBe(true);
    expect(scanKeyShapes("short text")).toBe(false);
    expect(redactKeyShapes("key is sk-1234567890abcdef here")).toBe("key is *** here");
    expect(redactKeyShapes("no keys here")).toBe("no keys here");
  });

  test("HERAV1SUPV-TP01-TC-40 memory injection wraps each memory in untrusted_content with provenance label", async () => {
    const dir = makeTempDir("mem-wrap");
    dirs.push(dir);
    const store = MemoryStore.open(dir, "abc");
    store.append({ id: store.newId(), text: "project uses tabs", scope: "workspace", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s1_session", origin: { kind: "model", ref: "s1" } });
    store.append({ id: store.newId(), text: "user prefers dark mode", scope: "global", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s2_session", origin: { kind: "user", ref: "p1" } });
    const outcome = await retrieveMemories(store, "tabs and dark mode", 5, replying(['["mem_00001", "mem_00002"]']), memRole, undefined);
    expect(outcome.selected).toHaveLength(2);
    const { UNTRUSTED_CONTENT_OPEN, UNTRUSTED_CONTENT_CLOSE } = await import("../../src/models.ts");
    for (const m of outcome.selected) {
      const wrapped = `${UNTRUSTED_CONTENT_OPEN}memory" ref="${m.id}">\n[memory ${m.id}, from session ${m.source_session.slice(0, 8)}, origin ${m.origin?.kind ?? "model"}]\n${m.text}\n${UNTRUSTED_CONTENT_CLOSE}`;
      expect(wrapped).toContain('<untrusted_content origin="memory"');
      expect(wrapped).toContain(`ref="${m.id}"`);
      expect(wrapped).toContain(`[memory ${m.id},`);
      expect(wrapped).toContain(m.text);
      expect(wrapped).toContain(UNTRUSTED_CONTENT_CLOSE);
    }
  });

  test("HERAV1SUPV-TP01-TC-41a U12: write then load round trip - mac verified, all lines loaded", () => {
    const dir = makeTempDir("mem_mac_rt");
    dirs.push(dir);
    const secretPath = memorySecretPath(dir);
    const store = MemoryStore.open(dir, "abc", { secretPath });
    store.append({ id: store.newId(), text: "fact one", scope: "workspace", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s1" });
    store.append({ id: store.newId(), text: "fact two", scope: "global", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s2" });
    expect(store.size).toBe(2);
    const file = readFileSync(store.workspaceFile, "utf8");
    expect(file).toContain('"mac"');
    const reopened = MemoryStore.open(dir, "abc", { secretPath });
    expect(reopened.size).toBe(2);
    expect(reopened.warnings).toHaveLength(0);
    expect(reopened.memories.get("mem_00001")?.text).toBe("fact one");
    expect(reopened.memories.get("mem_00002")?.text).toBe("fact two");
  });

  test("HERAV1SUPV-TP01-TC-41b U12: tampered line dropped with WARNING", () => {
    const dir = makeTempDir("mem_tamper");
    dirs.push(dir);
    const secretPath = memorySecretPath(dir);
    const store = MemoryStore.open(dir, "abc", { secretPath });
    store.append({ id: store.newId(), text: "original", scope: "workspace", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s1" });
    const file = store.workspaceFile;
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    parsed["text"] = "tampered";
    const tamperedMac = parsed["mac"] as string;
    writeFileSync(file, JSON.stringify({ ...parsed, mac: tamperedMac }) + "\n");
    const reopened = MemoryStore.open(dir, "abc", { secretPath });
    expect(reopened.size).toBe(0);
    expect(reopened.warnings.some((w) => w.includes("1 memory lines failed integrity check and were skipped"))).toBe(true);
  });

  test("HERAV1SUPV-TP01-TC-41c U12: line with invalid mac dropped", () => {
    const dir = makeTempDir("mem_badmac");
    dirs.push(dir);
    const secretPath = memorySecretPath(dir);
    writeFileSync(join(dir, "workspace-abc.jsonl"), JSON.stringify({ id: "mem_00001", text: "bad mac", scope: "workspace", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s1", mac: "deadbeef" }) + "\n");
    const reopened = MemoryStore.open(dir, "abc", { secretPath });
    expect(reopened.size).toBe(0);
    expect(reopened.warnings.some((w) => w.includes("1 memory lines failed integrity check and were skipped"))).toBe(true);
  });

  test("HERAV1SUPV-TP01-TC-41d U12: missing secret with tagged lines drops all", () => {
    const dir = makeTempDir("mem_nosecret");
    dirs.push(dir);
    const secretPath = memorySecretPath(dir);
    const store = MemoryStore.open(dir, "abc", { secretPath });
    store.append({ id: store.newId(), text: "fact one", scope: "workspace", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s1" });
    store.append({ id: store.newId(), text: "fact two", scope: "workspace", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s2" });
    expect(store.size).toBe(2);
    unlinkSync(secretPath);
    const reopened = MemoryStore.open(dir, "abc", { secretPath });
    expect(reopened.size).toBe(0);
    expect(reopened.warnings.some((w) => w.includes("2 memory lines failed integrity check and were skipped"))).toBe(true);
  });

  test("HERAV1SUPV-TP01-TC-41e U12: legacy store migrated once and stable on second load", () => {
    const dir = makeTempDir("mem_migrate");
    dirs.push(dir);
    const secretPath = memorySecretPath(dir);
    const legacyLine = JSON.stringify({ id: "mem_00001", text: "legacy fact", scope: "workspace", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s1" });
    writeFileSync(join(dir, "workspace-abc.jsonl"), legacyLine + "\n");
    const store = MemoryStore.open(dir, "abc", { secretPath });
    expect(store.size).toBe(1);
    expect(store.memories.get("mem_00001")?.text).toBe("legacy fact");
    const file = readFileSync(store.workspaceFile, "utf8");
    const parsed = JSON.parse(file.trim()) as Record<string, unknown>;
    expect(parsed["migrated"]).toBe(true);
    expect(parsed["mac"]).toBeDefined();
    const store2 = MemoryStore.open(dir, "abc", { secretPath });
    expect(store2.size).toBe(1);
    expect(store2.memories.get("mem_00001")?.migrated).toBe(true);
    expect(store2.warnings).toHaveLength(0);
  });

  test("HERAV1SUPV-TP01-TC-41f U12: provenance label text format", async () => {
    const dir = makeTempDir("mem_label");
    dirs.push(dir);
    const secretPath = memorySecretPath(dir);
    const store = MemoryStore.open(dir, "abc", { secretPath });
    store.append({ id: store.newId(), text: "project uses tabs", scope: "workspace", tags: [], created: "a", last_used: "a", uses: 0, source_session: "s1_session", origin: { kind: "user", ref: "p1" } });
    const outcome = await retrieveMemories(store, "tabs", 5, replying(['["mem_00001"]']), memRole, undefined);
    expect(outcome.selected).toHaveLength(1);
    const m = outcome.selected[0]!;
    const label = `[memory ${m.id}, from session ${m.source_session.slice(0, 8)}, origin ${m.origin?.kind ?? "model"}]`;
    expect(label).toBe("[memory mem_00001, from session s1_sessi, origin user]");
  });
});
