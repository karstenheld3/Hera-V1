import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nowTs, readJsonlFile, type AgentEvent } from "../../src/events.ts";
import { SessionStore, newSessionId, type EventSink, JsonlSink } from "../../src/session/store.ts";
import { SinkRouter } from "../../src/harness/sink.ts";
import { projectEvents } from "../../src/session/projection.ts";
import { makeTempDir, removeDir } from "../harness/procs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const delta = (i: number): AgentEvent => ({ ts: nowTs(), proc: "exec", type: "text_delta", text: `line ${i}` });

describe("HERAV1PROC-TP01 session store", () => {
  test("HERAV1PROC-IP01-TC-07 append 1000 events: readable in order after each append (flush-per-line)", () => {
    const dir = makeTempDir("store");
    dirs.push(dir);
    const store = SessionStore.open(dir, "new");
    expect(store.path).toMatch(/[\\/]sessions[\\/]\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{4}\.jsonl$/);
    expect(existsSync(store.path)).toBe(true);
    for (let i = 0; i < 1000; i++) {
      store.append(delta(i));
      if (i % 250 === 0) {
        // a concurrent reader sees the line right after append returned
        const text = readFileSync(store.path, "utf8");
        expect(text.trimEnd().split("\n")).toHaveLength(i + 1);
      }
    }
    store.close();
    const events = readJsonlFile(store.path).events;
    expect(events).toHaveLength(1000);
    expect(events[999]).toMatchObject({ type: "text_delta", text: "line 999" });
    expect(store.lines).toBe(1000);
  });

  test("HERAV1PROC-IP01-TC-08 open(resume) appends after existing lines without rewriting", () => {
    const dir = makeTempDir("store_resume");
    dirs.push(dir);
    const first = SessionStore.open(dir, "new");
    first.append(delta(1));
    first.append(delta(2));
    first.close();
    const before = readFileSync(first.path, "utf8");
    const resumed = SessionStore.openPath(first.path, "resume");
    resumed.append(delta(3));
    resumed.close();
    const after = readFileSync(first.path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(readJsonlFile(first.path).events).toHaveLength(3);
    expect(resumed.sessionId).toBe(first.sessionId);
  });

  test("HERAV1PROC-IP01-TC-09 append to a read-only file throws (caller sends no ack)", () => {
    const dir = makeTempDir("store_ro");
    dirs.push(dir);
    const store = SessionStore.open(dir, "new");
    store.append(delta(1));
    store.close();
    chmodSync(store.path, 0o444);
    let threw = false;
    try {
      const ro = SessionStore.openPath(store.path, "resume");
      ro.append(delta(2));
      ro.close();
    } catch {
      threw = true;
    }
    chmodSync(store.path, 0o644);
    expect(threw).toBe(true);
    expect(readJsonlFile(store.path).events).toHaveLength(1);
  });

  test("session ids are timestamp-prefixed and unique", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{4}$/);
    expect(a).not.toBe(b);
    const dir = makeTempDir("store_id");
    dirs.push(dir);
    const store = SessionStore.open(dir, "new", "2026-01-15_100000_abcd");
    expect(store.path).toBe(join(dir, "sessions", "2026-01-15_100000_abcd.jsonl"));
    store.close();
  });

  test("HERAV1HRNS-IP01-TC-15 SessionStore implements EventSink (JsonlSink alias)", () => {
    const dir = makeTempDir("store_sink");
    dirs.push(dir);
    const store: EventSink = SessionStore.open(dir, "new");
    expect(store).toBeInstanceOf(SessionStore);
    expect(store.isOpen).toBe(true);
    store.append(delta(0));
    store.append(delta(1));
    store.append(delta(2));
    const events = readJsonlFile((store as SessionStore).path).events;
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ type: "text_delta", text: "line 2" });
    (store as SessionStore).close();
    expect(store.isOpen).toBe(false);
  });

  test("JsonlSink is SessionStore (default EventSink)", () => {
    expect(JsonlSink).toBe(SessionStore);
  });

  test("SinkRouter routes events to the configured sink", () => {
    const dir = makeTempDir("store_router");
    dirs.push(dir);
    const store = SessionStore.open(dir, "new");
    const router = new SinkRouter(store);
    expect(router.isOpen).toBe(true);
    expect(router.hasSink).toBe(true);
    router.append(delta(0));
    router.append(delta(1));
    const events = readJsonlFile(store.path).events;
    expect(events).toHaveLength(2);
    store.close();
    expect(router.isOpen).toBe(false);
  });

  test("SinkRouter with no sink is a no-op", () => {
    const router = new SinkRouter(undefined);
    expect(router.hasSink).toBe(false);
    expect(router.isOpen).toBe(false);
    router.append(delta(0));
  });

  test("HERAV1PROC-TP01 projection wraps tool results through renderToolResult", () => {
    const events: AgentEvent[] = [
      { ts: nowTs(), proc: "exec", type: "session_started", system_prompt: "SYS", tool_definitions: [], config_snapshot: {}, definition_hash: "abc" },
      { ts: nowTs(), proc: "exec", type: "user_message", content: "hello", prompt_id: "p1" },
      { ts: nowTs(), proc: "exec", type: "turn_started", role: "generating", prompt_id: "p1" },
      { ts: nowTs(), proc: "exec", type: "tool_call_requested", id: "tc_1", tool: "read_file", args: {}, args_json: "{}" },
      { ts: nowTs(), proc: "exec", type: "tool_call_finished", id: "tc_1", status: "ok", result: "file content", result_chars: 12 },
      { ts: nowTs(), proc: "exec", type: "turn_finished", role: "generating", uncached_input: 10, cache_write: 0, cache_read: 0, output: 5, prompt_id: "p1" },
    ];
    const p = projectEvents(events);
    const toolMsg = p.messages.find((m) => m.role === "tool" && m.toolCallId === "tc_1");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('<untrusted_content origin="tool" ref="tc_1">');
    expect(toolMsg!.content).toContain("file content");
    expect(toolMsg!.content).toContain("</untrusted_content>");
  });
});
