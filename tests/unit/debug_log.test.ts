import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CompositeSink, FileSink, IpcSink, MemorySink, PipeSink, debugEnabled, disable, dlog, enable, logFileName, sanitize, uniqueLogPath, writeReceived, type DebugLine } from "../../src/debug/debuglog.ts";
import { formatDetail, renderLine } from "../../src/debug/viewer.ts";
import { formatDuration } from "../../src/cost.ts";
import pc from "picocolors";

const TMP = join(import.meta.dir, "..", ".tmp", "debug_units");
afterEach(() => {
  disable();
  rmSync(TMP, { recursive: true, force: true });
});

describe("HERAV1DEBG-TP01 writer", () => {
  test("HERAV1DEBG-IP01-TC-01 dlog before enable is a no-op; after enable lines carry ts, proc, dom, op; enable twice warns and keeps the first", () => {
    dlog("app", "startup", { mode: "console" });
    expect(debugEnabled()).toBe(false);
    const mem = new MemorySink();
    const warnings: string[] = [];
    expect(enable({ proc: "comm", sinks: [mem], stderr: (l) => warnings.push(l) })).toBe(true);
    dlog("app", "startup", { mode: "console", version: "2.0.0" });
    expect(mem.lines).toHaveLength(1);
    expect(mem.lines[0]).toMatchObject({ proc: "comm", dom: "app", op: "startup", mode: "console", version: "2.0.0" });
    expect(mem.lines[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    const second = new MemorySink();
    expect(enable({ proc: "exec", sinks: [second] })).toBe(false);
    expect(warnings[0]).toContain("already enabled");
    dlog("tool", "start", { tool: "read_file" });
    expect(mem.lines).toHaveLength(2);
    expect(second.lines).toHaveLength(0);
    writeReceived({ ts: "2026-09-06 15:00:00.000", proc: "exec", dom: "tool", op: "end", tool: "x" });
    expect(mem.lines[2]).toMatchObject({ proc: "exec", op: "end" });
  });

  test("HERAV1DEBG-IP01-TC-02 disabled fast path: 1,000,000 calls under 150 ms", () => {
    const started = performance.now();
    for (let i = 0; i < 1_000_000; i++) dlog("tool", "start", { tool: "x", i });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(300);
  });

  test("HERAV1DEBG-IP01-TC-03 sanitize: BigInt and circular values stringified, content-bearing keys redacted", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;
    const out = sanitize({ big: BigInt(7), circular, prompt: "secret prompt", result: "tool output", text: "t", content: "c", key: "sk-x", ok: 3, skip: undefined });
    expect(out["big"]).toBe("7");
    expect(out["circular"]).toBe("[object Object]");
    for (const k of ["prompt", "result", "text", "content", "key"]) expect(out[k]).toBe("<redacted>");
    expect(out["ok"]).toBe(3);
    expect("skip" in out).toBe(false);
  });
});

describe("HERAV1DEBG-TP01 sinks", () => {
  test("HERAV1DEBG-IP01-TC-04 PipeSink with a stalled writer: 1500 lines → 500 dropped, one debug_dropped after the drain, kept order preserved", async () => {
    const written: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const sink = new PipeSink(
      {
        write: async (text) => {
          if (first) {
            first = false;
            await gate;
          }
          written.push(text);
        },
      },
      () => undefined,
    );
    for (let i = 0; i < 1500; i++) sink.write({ ts: "t", proc: "comm", dom: "app", op: "n", i });
    expect(sink.pending).toBe(1000);
    release?.();
    await Bun.sleep(50);
    const lines = written.map((w) => JSON.parse(w) as DebugLine);
    // the first line went out before the stall; 1000 buffered survived; 499 were dropped from the front of the buffer
    const numbered = lines.filter((l) => l.op === "n").map((l) => l["i"] as number);
    expect(numbered[0]).toBe(0);
    expect(numbered.length).toBe(1001);
    for (let k = 1; k < numbered.length; k++) expect((numbered[k] as number) > (numbered[k - 1] as number)).toBe(true);
    const dropped = lines.filter((l) => l.op === "debug_dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.["count"]).toBe(499);
  });

  test("HERAV1DEBG-IP01-TC-05 PipeSink write error → dead with one warning; FileSink on an unwritable path → disabled with one warning; CompositeSink keeps the live member", async () => {
    const warnings: string[] = [];
    const pipe = new PipeSink({ write: () => Promise.reject(new Error("EPIPE")) }, (m) => warnings.push(m));
    pipe.write({ ts: "t", proc: "comm", dom: "app", op: "a" });
    await Bun.sleep(10);
    pipe.write({ ts: "t", proc: "comm", dom: "app", op: "b" });
    expect(pipe.dead).toBe(true);
    // a viewer that only connects later still receives the lines flushed before close
    const late: string[] = [];
    const lateSink = new PipeSink({ write: async (t) => void late.push(t) }, () => undefined);
    lateSink.write({ ts: "t", proc: "comm", dom: "app", op: "exit_code", code: 0 });
    await lateSink.flush();
    expect(late).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pipe broken");
    mkdirSync(TMP, { recursive: true });
    const asFile = join(TMP, "not-a-dir");
    writeFileSync(asFile, "x");
    const fileWarnings: string[] = [];
    const file = new FileSink(join(asFile, "sub"), (m) => fileWarnings.push(m));
    expect(file.disabled).toBe(true);
    expect(fileWarnings).toHaveLength(1);
    expect(fileWarnings[0]).toContain("not writable");
    const mem = new MemorySink();
    const composite = new CompositeSink([pipe, file, mem]);
    composite.write({ ts: "t", proc: "comm", dom: "app", op: "c" });
    expect(mem.lines).toHaveLength(1);
  });

  test("HERAV1DEBG-IP01-TC-06 FileSink naming, same-second collision suffix, relative dir resolved once, append per line", () => {
    const now = new Date(2026, 8, 6, 13, 30, 1);
    expect(logFileName(now)).toBe("hera-debug-2026-09-06_13-30-01.jsonl");
    mkdirSync(TMP, { recursive: true });
    const a = new FileSink(TMP, () => undefined, now);
    const b = new FileSink(TMP, () => undefined, now);
    expect(a.path.endsWith("hera-debug-2026-09-06_13-30-01.jsonl")).toBe(true);
    expect(b.path.endsWith("hera-debug-2026-09-06_13-30-01-2.jsonl")).toBe(true);
    expect(uniqueLogPath(TMP, now).endsWith("-3.jsonl")).toBe(true);
    a.write({ ts: "t", proc: "comm", dom: "app", op: "one" });
    a.write({ ts: "t", proc: "exec", dom: "tool", op: "two" });
    a.close();
    b.close();
    const lines = readFileSync(a.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ proc: "exec", op: "two" });
    expect(existsSync(b.path)).toBe(true);
  });

  test("HERAV1DEBG-IP01-TC-07 IpcSink hands the line to the sender and never awaits", () => {
    const sent: DebugLine[] = [];
    const sink = new IpcSink((line) => {
      sent.push(line);
    });
    sink.write({ ts: "t", proc: "exec", dom: "tool", op: "start", tool: "read_file" });
    expect(sent).toHaveLength(1);
    const throwing = new IpcSink(() => {
      throw new Error("channel gone");
    });
    expect(() => throwing.write({ ts: "t", proc: "exec", dom: "tool", op: "x" })).not.toThrow();
  });
});

describe("HERAV1DEBG-TP01 viewer renderer", () => {
  const plain = pc.createColors(false);

  test("HERAV1DEBG-IP01-TC-08 one line per domain: proc tag, aligned op, LOG-GN-04 durations, error and blocked emphasis", () => {
    expect(formatDuration(245)).toBe("245 ms");
    expect(formatDuration(1500)).toBe("1.5 secs");
    expect(formatDuration(150000)).toBe("2 mins 30 secs");
    expect(formatDuration(4500000)).toBe("1 hour 15 mins");
    const spawn = renderLine({ ts: "2026-09-06 13:30:01.004", proc: "comm", dom: "ipc", op: "spawn", role: "executor", pid: 6212, dur_ms: 41 }, plain);
    expect(spawn).toBe(`13:30:01.004 comm ipc  ${"spawn".padEnd(16)} executor pid=6212 41 ms`);
    const guard = renderLine({ ts: "2026-09-06 13:30:35.100", proc: "sup", dom: "sup", op: "guard", tool_call_id: "tc_0008", tool: "run_command", rule: "denylist", verdict: "block", eval_ms: 0.2, late: false }, plain);
    expect(guard).toContain("run_command denylist BLOCK 0.2 ms");
    expect(formatDetail({ dom: "llm", op: "response", role: "generating", dur_ms: 1234, in_tok: 100, cache_read: 20, out_tok: 10, cost_usd: 0.0012, tool_calls: 1 })).toBe("generating 1.2 secs in=100 (cache 20) out=10 $0.0012 tool_calls=1");
    expect(formatDetail({ dom: "tool", op: "end", tool: "edit", dur_ms: 12, status: "error", chars: 40, err: "boom" })).toBe("edit 12 ms error 40 chars boom");
    expect(formatDetail({ dom: "acp", op: "turn", id: 3, dur_ms: 2000, stop: "end_turn", updates: 12 })).toBe("id=3 2.0 secs end_turn updates=12");
    expect(formatDetail({ dom: "app", op: "session", file: "s.jsonl", resumed: true, dur_ms: 30 })).toBe("'s.jsonl' (resumed) 30 ms");
    expect(formatDetail({ dom: "sup", op: "stall", silent_s: 12, action: "resume" })).toBe("silent 12 s -> resume");
    expect(formatDetail({ dom: "zzz", op: "custom", a: 1 })).toBe('{"a":1}');
    // colored: error op red, blocked magenta
    const red = renderLine({ ts: "t", proc: "exec", dom: "llm", op: "error", err: "x" });
    expect(red).toContain("\u001b[31m");
    const magenta = renderLine({ ts: "t", proc: "sup", dom: "sup", op: "guard", tool: "rm", rule: "denylist", verdict: "block", eval_ms: 1 });
    expect(magenta).toContain("\u001b[35m");
  });

  test("HERAV1DEBG-IP01-TC-09 missing proc → '?', time-only ts rendered as-is", () => {
    const line = renderLine({ ts: "13:30:01.004", dom: "tool", op: "start", tool: "read_file", args: "a.md" }, plain);
    expect(line.startsWith("13:30:01.004 ?    tool ")).toBe(true);
    expect(line).toContain("read_file 'a.md'");
  });
});
