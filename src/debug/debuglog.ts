// Debug log writer and sinks (HERAV1DEBG-SP01; HERAV1DEBG-IP01 IS-01, IS-02). Port of V1 debuglog.py.
// `dlog()` is a single null check when disabled (IG-04). Only the Communicator owns the viewer pipe and the log
// file (DD-02); children send `debug_line` IPC messages through the same `dlog()`. No stdout or stdin anywhere here.

import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { nowTs } from "../events.ts";
import type { ProcId } from "../models.ts";

export type DebugDomain = "llm" | "tool" | "ipc" | "sup" | "acp" | "app" | "exec";

export interface DebugLine {
  ts: string;
  proc: ProcId;
  dom: string;
  op: string;
  [key: string]: unknown;
}

export interface Sink {
  write(line: DebugLine): void;
  /** resolves when buffered lines were handed to the transport (async sinks) */
  flush?(): Promise<void>;
  close?(): void;
}

const REDACTED_KEYS = new Set(["prompt", "result", "text", "content", "key", "api_key", "system", "messages"]);
export const PIPE_BUFFER_MAX = 1000;

let sink: Sink | null = null;
let procId: ProcId = "comm";
let stderr: (line: string) => void = (l) => void process.stderr.write(`${l}\n`);

/** Replaces non-serializable values by their String() form and redacts content-bearing keys (EC-03, IG-05). */
export function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(k)) {
      out[k] = "<redacted>";
      continue;
    }
    if (v === undefined) continue;
    if (typeof v === "bigint" || typeof v === "function" || typeof v === "symbol") {
      out[k] = String(v);
      continue;
    }
    if (typeof v === "object" && v !== null) {
      try {
        JSON.stringify(v);
        out[k] = v;
      } catch {
        out[k] = String(v);
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function dlog(dom: DebugDomain | string, op: string, fields: Record<string, unknown> = {}): void {
  if (!sink) return;
  sink.write({ ts: nowTs(), proc: procId, dom, op, ...sanitize(fields) });
}

export function debugEnabled(): boolean {
  return sink !== null;
}

/** Forwards a child's line unchanged (IG-06). */
export function writeReceived(line: DebugLine): void {
  if (!sink) return;
  sink.write(line);
}

export interface EnableOptions {
  proc: ProcId;
  sinks: Sink[];
  stderr?: (line: string) => void;
}

/** Installs the sink set once; a second call is ignored with one stderr warning (EC-01). */
export function enable(opts: EnableOptions): boolean {
  if (opts.stderr !== undefined) stderr = opts.stderr;
  if (sink !== null) {
    stderr("WARNING: debug log already enabled -> second configuration ignored.");
    return false;
  }
  if (opts.sinks.length === 0) return false;
  procId = opts.proc;
  sink = opts.sinks.length === 1 ? (opts.sinks[0] as Sink) : new CompositeSink(opts.sinks);
  return true;
}

/** Tests only: drops the sink so the fast path is measurable again. */
export function disable(): void {
  sink?.close?.();
  sink = null;
}

/** Fans out to every member; a dead member never stops the others (spec EC-11). */
export class CompositeSink implements Sink {
  constructor(private readonly members: Sink[]) {}
  write(line: DebugLine): void {
    for (const m of this.members) {
      try {
        m.write(line);
      } catch {
        /* member failures are reported by the member itself */
      }
    }
  }
  async flush(): Promise<void> {
    for (const m of this.members) await m.flush?.();
  }
  close(): void {
    for (const m of this.members) m.close?.();
  }
}

export interface PipeWriter {
  /** resolves when the bytes were handed to the OS; rejects on a broken pipe */
  write(text: string): Promise<void>;
  close?(): void;
}

/** Bounded asynchronous pipe sink: 1000 lines buffered, overflow drops the oldest and reports one `debug_dropped` line after draining (NFR-01). */
export class PipeSink implements Sink {
  private readonly buffer: DebugLine[] = [];
  private draining = false;
  private dropped = 0;
  dead = false;
  constructor(
    private readonly writer: PipeWriter,
    private readonly onDead: (message: string) => void,
    private readonly max = PIPE_BUFFER_MAX,
  ) {}

  write(line: DebugLine): void {
    if (this.dead) return;
    if (this.buffer.length >= this.max) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(line);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.buffer.length > 0 && !this.dead) {
        const next = this.buffer.shift() as DebugLine;
        try {
          await this.writer.write(`${JSON.stringify(next)}\n`);
        } catch (error) {
          this.dead = true;
          this.buffer.length = 0;
          this.onDead(`WARNING: debug console pipe broken (${error instanceof Error ? error.message : String(error)}) -> viewer logging disabled for this session.`);
          return;
        }
        if (this.buffer.length === 0 && this.dropped > 0) {
          const count = this.dropped;
          this.dropped = 0;
          this.buffer.push({ ts: nowTs(), proc: "comm", dom: "app", op: "debug_dropped", count });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  get pending(): number {
    return this.buffer.length;
  }

  async flush(): Promise<void> {
    const deadline = performance.now() + 2000;
    while (!this.dead && (this.buffer.length > 0 || this.draining) && performance.now() < deadline) await new Promise<void>((r) => setTimeout(r, 5));
  }

  close(): void {
    this.dead = true;
    this.buffer.length = 0;
    this.writer.close?.();
  }
}

/** Append-and-flush file sink; the first write error disables it with one stderr warning (spec EC-10). */
export class FileSink implements Sink {
  readonly path: string;
  private fd: number | undefined;
  disabled = false;
  constructor(
    dir: string,
    private readonly onDisabled: (message: string) => void,
    now: Date = new Date(),
  ) {
    const resolved = resolve(dir);
    try {
      mkdirSync(resolved, { recursive: true });
      this.path = uniqueLogPath(resolved, now);
      this.fd = openSync(this.path, "a");
    } catch (error) {
      this.path = join(resolved, logFileName(now));
      this.disabled = true;
      onDisabled(`WARNING: --log-dir '${resolved}' is not writable (${error instanceof Error ? error.message : String(error)}) -> file logging disabled.`);
    }
  }

  write(line: DebugLine): void {
    if (this.disabled || this.fd === undefined) return;
    try {
      writeSync(this.fd, `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.disabled = true;
      this.onDisabled(`WARNING: debug log file '${this.path}' failed (${error instanceof Error ? error.message : String(error)}) -> file logging disabled.`);
    }
  }

  close(): void {
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = undefined;
    }
  }
}

/** Child-side sink: fire-and-forget `debug_line` message to the Communicator (DD-02). */
export class IpcSink implements Sink {
  constructor(private readonly send: (line: DebugLine) => void) {}
  write(line: DebugLine): void {
    try {
      this.send(line);
    } catch {
      /* channel gone: the disconnect handler ends the process */
    }
  }
}

/** Test sink collecting lines in memory. */
export class MemorySink implements Sink {
  readonly lines: DebugLine[] = [];
  write(line: DebugLine): void {
    this.lines.push(line);
  }
}

export function logFileName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `hera-debug-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}.jsonl`;
}

/** Same-second collision → `-2`, `-3`, ... suffix (EC-02). */
export function uniqueLogPath(dir: string, now: Date): string {
  const base = logFileName(now);
  let candidate = join(dir, base);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, base.replace(/\.jsonl$/, `-${n}.jsonl`));
    n++;
  }
  return candidate;
}
