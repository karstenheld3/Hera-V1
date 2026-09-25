// Debug viewer (HERAV1DEBG-SP01 FR-09; HERAV1DEBG-IP01 IS-04). Port of V1 debug_viewer.py to picocolors. Runs in
// its own console window: reads JSONL lines from stdin, renders `HH:MM:SS.mmm proc dom op detail`, on EOF prints the
// closed notice and waits for a keypress. Output goes to CONOUT$ on Windows (the process's own console, regardless of
// inherited handles) and to this process's stdout elsewhere - the viewer is the only debug module that writes a console.

import { closeSync, openSync, writeSync } from "node:fs";
import { pc, type Colors } from "../colors.ts";
import type { ParsedArgs } from "../args.ts";
import { formatDuration, formatUsd } from "../cost.ts";

const DOMAIN_COLORS: Record<string, keyof Colors> = { llm: "cyan", tool: "green", ipc: "blue", sup: "magenta", acp: "yellow", app: "white", exec: "green" };
const PROC_COLORS: Record<string, keyof Colors> = { comm: "white", exec: "green", sup: "magenta" };
const ERROR_OPS = new Set(["error", "compaction_failed", "store_error", "guard_timeout", "reject", "exit"]);
const WARNING_OPS = new Set(["retry", "debug_dropped", "overflow", "heartbeat_gap", "cost_alert", "late_verdict_ignored", "late_block_ignored"]);
const MAGENTA_OPS = new Set(["stall", "restart", "restart_request"]);

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const dur = (v: unknown): string => (typeof v === "number" ? formatDuration(v) : "");

/** One human-readable detail per (dom, op); unknown ops fall back to a compact field dump. */
export function formatDetail(entry: Record<string, unknown>): string {
  const dom = str(entry["dom"]);
  const op = str(entry["op"]);
  const e = entry;
  if (dom === "llm") {
    if (op === "request") return `${str(e["role"])} ${str(e["provider"])} ${str(e["model"])} msgs=${str(e["msgs"] ?? 0)} tools=${str(e["tools"] ?? 0)}`;
    if (op === "first_token") return dur(e["dur_ms"]);
    if (op === "response") return `${str(e["role"])} ${dur(e["dur_ms"])} in=${str(e["in_tok"] ?? 0)} (cache ${str(e["cache_read"] ?? 0)}) out=${str(e["out_tok"] ?? 0)} ${formatUsd(typeof e["cost_usd"] === "number" ? e["cost_usd"] : null)} tool_calls=${str(e["tool_calls"] ?? 0)}`;
    if (op === "retry" || op === "error") return `${dur(e["dur_ms"])} ${str(e["err"])}`.trim();
    if (op === "sidecall") return `${str(e["role"])} ${str(e["provider"])} ${str(e["model"])} ${dur(e["dur_ms"])} results=${str(e["results"] ?? 0)}`;
  } else if (dom === "tool") {
    if (op === "start") return e["args"] !== undefined && e["args"] !== "" ? `${str(e["tool"])} '${str(e["args"])}'` : str(e["tool"]);
    if (op === "end") return `${str(e["tool"])} ${dur(e["dur_ms"])} ${str(e["status"])} ${str(e["chars"] ?? 0)} chars${e["err"] !== undefined ? ` ${str(e["err"])}` : ""}`;
    if (op === "guard") return `${str(e["tool"])} ${str(e["rule"])} ${str(e["verdict"]).toUpperCase()} ${dur(e["wait_ms"])}${e["timeout"] === true ? " TIMEOUT" : ""}`;
    if (op === "ask_user") return `${str(e["kind"])} ${dur(e["wait_ms"])}`;
  } else if (dom === "ipc") {
    if (op === "spawn") return `${str(e["role"])} pid=${str(e["pid"])} ${dur(e["dur_ms"])}`;
    if (op === "hello") return `${str(e["role"])} ready in ${dur(e["ready_ms"])}`;
    if (op === "ack") return `ref=${str(e["ref"])} ${str(e["event"])} ${dur(e["dur_ms"])}`;
    if (op === "ack_wait") return `ref=${str(e["ref"])} rtt ${dur(e["rtt_ms"])}`;
    if (op === "turn_summary") return `sent=${str(e["sent"])} received=${str(e["received"])} relayed=${str(e["relayed"])} ack_p99=${dur(e["ack_p99_ms"])}${e["aborted"] === true ? " ABORTED" : ""}`;
    if (op === "exit") return `${str(e["role"])} code=${str(e["code"])} signal=${str(e["signal"])} detected in ${dur(e["detect_ms"])}`;
    if (op === "restart") return `${str(e["role"])} attempt ${str(e["attempt"])} of ${str(e["budget"])} resume ${dur(e["resume_ms"])}`;
    if (op === "shutdown") return `${str(e["role"])} wait ${dur(e["wait_ms"])}${e["killed"] === true ? " KILLED" : ""}`;
    if (op === "heartbeat_gap") return `${str(e["role"])} late by ${str(e["late_s"])} s`;
    if (op === "reject") return str(e["reason"]);
  } else if (dom === "sup") {
    if (op === "guard") return `${str(e["tool"])} ${str(e["rule"])} ${str(e["verdict"]).toUpperCase()} ${dur(e["eval_ms"])}${e["late"] === true ? " LATE" : ""}`;
    if (op === "stall") return `silent ${str(e["silent_s"])} s -> ${str(e["action"])}`;
    if (op === "resumed") return `${str(e["reason"])} recovered in ${dur(e["recovery_ms"])}`;
    if (op === "review") return `${str(e["trigger"])} calls=${str(e["calls"])} ${str(e["outcome"])} ${dur(e["dur_ms"])} ${formatUsd(typeof e["cost_usd"] === "number" ? e["cost_usd"] : null)}`;
    if (op === "extract") return `candidates=${str(e["candidates"])} new=${str(e["new"])} merged=${str(e["merged"])} ${dur(e["dur_ms"])}`;
    if (op === "retrieve") return `candidates=${str(e["candidates"])} selected=${str(e["selected"])} ${dur(e["dur_ms"])}`;
    if (op === "inject") return `${str(e["count"])} memories ${str(e["bytes"])} bytes`;
    if (op === "cost_alert") return `turn ${formatUsd(typeof e["turn_usd"] === "number" ? e["turn_usd"] : null)} > ${formatUsd(typeof e["threshold_usd"] === "number" ? e["threshold_usd"] : null)}`;
  } else if (dom === "acp") {
    if (op === "recv") return `${str(e["method"])}${e["id"] !== undefined ? ` id=${str(e["id"])}` : ""}`;
    if (op === "send") return `${str(e["method"])} id=${str(e["id"])} ${dur(e["dur_ms"])} ${str(e["status"])}`;
    if (op === "roundtrip") return `${str(e["method"])} ${dur(e["dur_ms"])} ${str(e["outcome"])}`;
    if (op === "turn") return `id=${str(e["id"])} ${dur(e["dur_ms"])} ${str(e["stop"])} updates=${str(e["updates"] ?? 0)}`;
    if (op === "overflow") return `dropped ${str(e["dropped"])} notifications`;
    if (op === "eof") return "stdin EOF - server shutting down";
  } else if (dom === "app") {
    if (op === "startup") return `${str(e["mode"])} v${str(e["version"])}${e["standalone"] === true ? " standalone" : ""}`;
    if (op === "roles") return str(e["roles"]);
    if (op === "session") return `'${str(e["file"])}'${e["resumed"] === true ? " (resumed)" : ""}${e["dur_ms"] !== undefined ? ` ${dur(e["dur_ms"])}` : ""}`;
    if (op === "prompt_system") return `${str(e["rules"] ?? 0)} rules, ${str(e["workflows"] ?? 0)} workflows, ${str(e["skills"] ?? 0)} skills ${dur(e["dur_ms"])}`;
    if (op === "compaction_start") return `projected=${str(e["projected"])} threshold=${str(e["threshold"])} tokens`;
    if (op === "compaction") return `truncated=${str(e["truncated"])} kept=${str(e["kept"])} checkpoint=${str(e["checkpoint_chars"])} chars`;
    if (op === "compaction_failed") return str(e["err"]);
    if (op === "debug_dropped") return `${str(e["count"])} lines dropped`;
    if (op === "exit_code") return `${str(e["code"])} (${str(e["source"])})`;
  }
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) if (k !== "ts" && k !== "proc" && k !== "dom" && k !== "op") rest[k] = v;
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";
}

/** Renders one parsed line; `colors` may be disabled for tests. */
export function renderLine(entry: Record<string, unknown>, c: Colors = pc): string {
  const dom = str(entry["dom"]) || "?";
  const op = str(entry["op"]) || "?";
  const proc = entry["proc"] === undefined ? "?" : str(entry["proc"]);
  const ts = str(entry["ts"]);
  const time = ts.length > 12 ? ts.slice(-12) : ts;
  const detail = formatDetail(entry);
  const isError = ERROR_OPS.has(op) || entry["status"] === "error" || entry["verdict"] === "error";
  const isWarning = !isError && WARNING_OPS.has(op);
  const isMagenta = !isError && (MAGENTA_OPS.has(op) || entry["verdict"] === "block" || entry["status"] === "blocked");
  const paint = (text: string): string => (isError ? c.red(text) : isWarning ? c.yellow(text) : isMagenta ? c.magenta(text) : text);
  const domColor = c[DOMAIN_COLORS[dom] ?? "white"] as (t: string) => string;
  const procColor = c[PROC_COLORS[proc] ?? "white"] as (t: string) => string;
  return `${c.dim(time.padEnd(12))} ${procColor(proc.padEnd(4))} ${isError ? c.red(dom.padEnd(4)) : domColor(dom.padEnd(4))} ${paint(c.bold(op.padEnd(16)))} ${paint(detail)}`;
}

export function renderRaw(line: string, c: Colors = pc): string {
  return c.dim(line);
}

interface ConsoleOut {
  write(text: string): void;
  close(): void;
}

/** CONOUT$ addresses this process's own console on Windows regardless of inherited handles (spec EC-08). */
function openConsole(): ConsoleOut {
  if (process.platform === "win32" && process.env["HERA_VIEWER_STDOUT"] === undefined) {
    try {
      const fd = openSync("CONOUT$", "w");
      return { write: (t) => void writeSync(fd, t), close: () => closeSync(fd) };
    } catch {
      /* no own console (direct piped invocation, spec EC-07) - fall back to stdout */
    }
  }
  return { write: (t) => void process.stdout.write(t), close: () => undefined };
}

async function waitForKey(): Promise<void> {
  if (process.platform === "win32") {
    try {
      const fd = openSync("CONIN$", "r");
      const buf = new Uint8Array(1);
      const { readSync } = await import("node:fs");
      readSync(fd, buf);
      closeSync(fd);
      return;
    } catch {
      return;
    }
  }
  await new Promise<void>((r) => setTimeout(r, 200));
}

/** Line source: the loopback socket given by `--connect host:port` (window mode) or stdin (direct piped invocation). */
async function* lineSource(connect: string | undefined): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  const split = (chunk: Uint8Array): string[] => {
    pending += decoder.decode(chunk, { stream: true });
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    return parts;
  };
  if (connect === undefined) {
    for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) yield* split(chunk);
  } else {
    const [host, portText] = connect.split(":");
    const queue: Uint8Array[] = [];
    let done = false;
    let wake: (() => void) | undefined;
    const notify = (): void => {
      wake?.();
      wake = undefined;
    };
    try {
      await Bun.connect({
        hostname: host === undefined || host.length === 0 ? "127.0.0.1" : host,
        port: Number(portText ?? "0"),
        socket: {
          data: (_s, data) => {
            queue.push(data);
            notify();
          },
          close: () => {
            done = true;
            notify();
          },
          error: () => {
            done = true;
            notify();
          },
          connectError: () => {
            done = true;
            notify();
          },
        },
      });
    } catch {
      done = true;
    }
    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((r) => {
          wake = r;
        });
        continue;
      }
      yield* split(queue.shift() as Uint8Array);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) yield pending;
}

export async function viewerMain(args: ParsedArgs): Promise<number> {
  try {
    return await runViewer(args);
  } catch (error) {
    const probe = process.env["HERA_VIEWER_PROBE"];
    if (probe !== undefined) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(probe, `\nERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    process.stderr.write(`ERROR: debug viewer failed -> ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runViewer(args: ParsedArgs): Promise<number> {
  const out = openConsole();
  const c = pc;
  process.title = "Hera Debug Console";
  const probe = process.env["HERA_VIEWER_PROBE"];
  if (probe !== undefined) {
    // test hook (TC-11): record whether this process owns a console
    let owns = false;
    try {
      closeSync(openSync("CONOUT$", "w"));
      owns = true;
    } catch {
      owns = false;
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(probe, JSON.stringify({ pid: process.pid, console: owns }));
  }
  out.write(`${c.bold(args.connect === undefined ? "Hera Debug Console - connected" : `Hera Debug Console - connected to ${args.connect}`)}\n`);
  let rendered = 0;
  const handle = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      out.write(`${renderRaw(trimmed, c)}\n`);
      return;
    }
    if (typeof entry !== "object" || entry === null) {
      out.write(`${renderRaw(trimmed, c)}\n`);
      return;
    }
    try {
      out.write(`${renderLine(entry as Record<string, unknown>, c)}\n`);
      rendered++;
    } catch {
      out.write(`${renderRaw(trimmed, c)}\n`);
    }
  };
  for await (const line of lineSource(args.connect)) handle(line);
  out.write(`${c.bold(c.yellow(`-- connection closed (Hera exited) - ${rendered} lines - press any key to close --`))}\n`);
  if (process.env["HERA_VIEWER_NO_WAIT"] === undefined) await waitForKey();
  out.close();
  return 0;
}
