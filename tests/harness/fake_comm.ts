// Fake Communicator: parent for exactly one child role over Bun ipc (HERAV1AGNT-IP01 IS-08, HERAV1PROC-TP01).
// Speaks the real envelope, records every message, and acknowledges `event` and `session_open` on demand.

import { nowTs } from "../../src/events.ts";
import { validate, type IpcMessage, type IpcMessageOf, type MessageType, type PayloadOf } from "../../src/process/envelope.ts";
import type { ChildRole } from "../../src/models.ts";
import { PROTOCOL_VERSION } from "../../src/version.ts";
import { ENTRY, waitFor } from "./procs.ts";

export interface RecordedMessage {
  dir: "in" | "out";
  at: number;
  msg: IpcMessage;
}

export interface FakeCommOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** acknowledge `event` and `session_open` automatically (default true) */
  autoAck?: boolean;
  /** delay before an automatic ack in ms (default 0) */
  ackDelayMs?: number;
  stdout?: "ignore" | "pipe";
}

export class FakeComm {
  received: IpcMessage[] = [];
  sent: IpcMessage[] = [];
  recorded: RecordedMessage[] = [];
  rejected: Array<{ raw: unknown; reason: string }> = [];
  exitCode: number | null = null;
  signal: string | null = null;
  exitedAt: number | undefined;
  stderrText = "";
  stdoutText = "";
  autoAck: boolean;
  private proc: BunSubprocess | undefined;
  private nextId = 1;
  private readonly opts: FakeCommOptions;
  private readonly exitPromise: Promise<void>;
  private resolveExit: (() => void) | undefined;

  constructor(opts: FakeCommOptions = {}) {
    this.opts = opts;
    this.autoAck = opts.autoAck ?? true;
    this.exitPromise = new Promise<void>((res) => {
      this.resolveExit = res;
    });
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Spawns `bun run src/index.ts --role <role> --epoch <n>` (or the binary under HERA_TEST_BINARY) with an ipc channel. */
  async spawn(role: ChildRole, epoch = 1): Promise<void> {
    const binary = process.env["HERA_TEST_BINARY"];
    const cmd = binary !== undefined && binary.length > 0 ? [binary, "--role", role, "--epoch", String(epoch)] : [process.execPath, "run", ENTRY, "--role", role, "--epoch", String(epoch)];
    const stderr = { text: "" };
    this.proc = Bun.spawn(cmd, {
      cwd: this.opts.cwd ?? process.cwd(),
      env: { ...process.env, ...this.opts.env },
      stdin: "ignore",
      stdout: this.opts.stdout ?? "ignore",
      stderr: "pipe",
      serialization: "json",
      ipc: (message: unknown) => this.onMessage(message),
      onExit: (_p, code, signal) => {
        this.exitCode = code;
        this.signal = signal;
        this.exitedAt = performance.now();
        this.resolveExit?.();
      },
    });
    const errStream = this.proc.stderr;
    if (errStream !== undefined && typeof errStream !== "number") {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of errStream as unknown as AsyncIterable<Uint8Array>) {
          stderr.text += decoder.decode(chunk, { stream: true });
          this.stderrText = stderr.text;
        }
      })();
    }
    const outStream = this.proc.stdout;
    if (outStream !== undefined && typeof outStream !== "number") {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of outStream as unknown as AsyncIterable<Uint8Array>) this.stdoutText += decoder.decode(chunk, { stream: true });
      })();
    }
  }

  private onMessage(raw: unknown): void {
    const result = validate(raw);
    if (!result.ok) {
      this.rejected.push({ raw, reason: result.reason });
      return;
    }
    this.received.push(result.msg);
    this.recorded.push({ dir: "in", at: performance.now(), msg: result.msg });
    if (this.autoAck && (result.msg.type === "event" || result.msg.type === "session_open" || result.msg.type === "hello")) {
      const ref = result.msg.id;
      if (this.opts.ackDelayMs !== undefined && this.opts.ackDelayMs > 0) {
        setTimeout(() => this.ack(ref), this.opts.ackDelayMs);
      } else {
        this.ack(ref);
      }
    }
  }

  send<T extends MessageType>(type: T, payload: PayloadOf<T>): number {
    if (this.proc === undefined) throw new Error("FakeComm.send before spawn");
    const to = this.received.find((m) => m.type === "hello")?.from ?? "exec";
    const msg: IpcMessageOf<T> = { v: PROTOCOL_VERSION, id: this.nextId++, from: "comm", to, type, ts: nowTs(), run_ctx: "", seq: this.nextId - 1, payload };
    this.proc.send(msg);
    this.sent.push(msg as unknown as IpcMessage);
    this.recorded.push({ dir: "out", at: performance.now(), msg: msg as unknown as IpcMessage });
    return msg.id;
  }

  /** Sends a raw object without validation (for reject tests). */
  sendRaw(raw: unknown): void {
    if (this.proc === undefined) throw new Error("FakeComm.sendRaw before spawn");
    this.proc.send(raw);
  }

  ack(ref: number): void {
    this.send("ack", { ref });
  }

  async waitFor(pred: (m: IpcMessage) => boolean, timeoutMs: number, what = "message"): Promise<IpcMessage> {
    let found: IpcMessage | undefined;
    await waitFor(() => {
      found = this.received.find(pred);
      return found !== undefined;
    }, timeoutMs, what);
    return found as IpcMessage;
  }

  /** Resolves with the exit record, or undefined when the child is still alive after `timeoutMs`. */
  async waitExit(timeoutMs: number): Promise<{ code: number | null; signal: string | null } | undefined> {
    const result = await Promise.race([this.exitPromise.then(() => "exited" as const), Bun.sleep(timeoutMs).then(() => "timeout" as const)]);
    if (result === "timeout") return undefined;
    return { code: this.exitCode, signal: this.signal };
  }

  /** Sends shutdown, waits, kills if needed; returns the exit code (null when killed or still alive). */
  async shutdown(timeoutMs = 3000): Promise<number | null> {
    if (this.proc === undefined) return null;
    if (this.exitedAt === undefined) {
      try {
        this.send("shutdown", {});
      } catch {
        /* channel closed */
      }
    }
    const exit = await this.waitExit(timeoutMs);
    if (exit === undefined) {
      this.kill();
      await this.waitExit(2000);
      return null;
    }
    return exit.code;
  }

  kill(): void {
    this.proc?.kill();
  }

  sequence(dir?: "in" | "out"): string[] {
    return this.recorded.filter((r) => dir === undefined || r.dir === dir).map((r) => r.msg.type);
  }
}
