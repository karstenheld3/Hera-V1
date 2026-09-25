// ChildRuntime: the child side of the process model shared by the Executor and the Supervisor
// (HERAV1PROC-IP01 IS-04): hello, heartbeat, session_open/shutdown handling, channel-close exit,
// and the write-ahead event path with the alive-channel acknowledgement rule (FR-03).

import { IpcSink, enable as enableDebug } from "../debug/debuglog.ts";
import { ConfigError } from "../errors.ts";
import { nowTs, type AgentEvent } from "../events.ts";
import { procIdOf, type ChildRole, type ProcId } from "../models.ts";
import { VERSION } from "../version.ts";
import { hasIpcChannel } from "./bootstrap.ts";
import type { IpcMessage, MessageType, PayloadOf } from "./envelope.ts";
import { AckTimeout, HeartbeatTimer, IpcChannel } from "./ipc.ts";

export type ShutdownReason = "shutdown" | "disconnect" | "comm_dead";

export interface RoleHandlers {
  /** role-specific heartbeat fields (phase, phase_since, turn_usage, children, turn_active) */
  heartbeat(): Partial<PayloadOf<"heartbeat">>;
  /** runs BEFORE the ack of session_open so the Communicator learns "loaded" (FR-09) */
  onSessionOpen(payload: PayloadOf<"session_open">, runtime: ChildRuntime): Promise<void>;
  /** every message that is not hello/ack/session_open/shutdown */
  onMessage(msg: IpcMessage, runtime: ChildRuntime): void | Promise<void>;
  /** finalizer: cancel model calls, terminate tool children, flush stores; must return quickly */
  onShutdown(reason: ShutdownReason, runtime: ChildRuntime): Promise<void>;
}

export interface ChildRuntimeOptions {
  heartbeatMs?: number;
  ackTimeoutMs?: number;
  version?: string;
  /** injected for tests; defaults to process.send / process.on */
  transport?: { send(message: unknown): void; onMessage(handler: (raw: unknown) => void): void; onDisconnect(handler: () => void): void };
  exit?: (code: number) => never;
  onReject?(raw: unknown, reason: string): void;
}

export class ChildRuntime {
  readonly role: ChildRole;
  readonly proc: ProcId;
  readonly epoch: number;
  readonly channel: IpcChannel;
  readonly heartbeat: HeartbeatTimer;
  lastEventId = 0;
  ackTimeoutMs: number;
  sessionOpen: PayloadOf<"session_open"> | undefined;
  /** Sets the run_ctx from admit() - stamped on every subsequent envelope (FR-06). */
  runCtx = "";
  setRunCtx(runCtx: string): void {
    this.runCtx = runCtx;
    this.channel.setRunCtx(runCtx);
  }

  /** Sets the prompt_id for the current turn - stamped on every event (FR-06). */
  promptId = "";
  setPromptId(promptId: string): void {
    this.promptId = promptId;
  }
  private readonly handlers: RoleHandlers;
  private readonly exitFn: (code: number) => never;
  private readonly version: string;
  private shuttingDown = false;
  private readonly transport: NonNullable<ChildRuntimeOptions["transport"]>;
  private readonly transportInjected: boolean;

  constructor(role: ChildRole, epoch: number | undefined, handlers: RoleHandlers, opts: ChildRuntimeOptions = {}) {
    this.role = role;
    this.proc = procIdOf(role);
    this.epoch = epoch ?? 0;
    this.handlers = handlers;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 5000;
    this.version = opts.version ?? VERSION;
    this.exitFn = opts.exit ?? ((code: number) => process.exit(code));
    this.transportInjected = opts.transport !== undefined;
    this.transport = opts.transport ?? {
      send: (message) => {
        process.send?.(message);
      },
      onMessage: (handler) => {
        process.on("message", handler);
      },
      onDisconnect: (handler) => {
        process.on("disconnect", handler);
      },
    };
    this.channel = new IpcChannel({ self: this.proc, peer: "comm", transport: { send: (m) => this.transport.send(m) }, onReject: opts.onReject });
    this.heartbeat = new HeartbeatTimer(opts.heartbeatMs ?? 5000, () => this.sendHeartbeat());
  }

  /** Asserts the IPC channel (EC-14), wires message and disconnect handlers, sends hello, starts the heartbeat. */
  start(): void {
    if (!this.transportInjected) assertSpawnedByCommunicator(this.role);
    // HERAV1DEBG-SP01 FR-01: the Communicator sets HERA_DEBUG_LINES when a debug sink is active; children never parse flags
    if (process.env["HERA_DEBUG_LINES"] !== undefined) enableDebug({ proc: this.proc, sinks: [new IpcSink((line) => void this.channel.send("debug_line", line))] });
    this.transport.onMessage((raw) => this.channel.dispatch(raw));
    this.transport.onDisconnect(() => void this.terminate("disconnect", 0));
    this.channel.onMessage((msg) => void this.route(msg));
    this.channel.send("hello", { role: this.role, pid: process.pid, version: this.version, standalone: Bun.isStandaloneExecutable, epoch: this.epoch });
    this.heartbeat.start();
  }

  private async route(msg: IpcMessage): Promise<void> {
    if (msg.to !== this.proc) {
      // a fan-out copy (Supervisor, FR-05): observe event / prompt / heartbeat copies, never act on control types, never ack
      if (msg.type === "event" || msg.type === "prompt" || msg.type === "heartbeat") await this.handlers.onMessage(msg, this);
      return;
    }
    switch (msg.type) {
      case "ack":
        return;
      case "session_open":
        try {
          this.sessionOpen = msg.payload;
          await this.handlers.onSessionOpen(msg.payload, this);
        } catch (error) {
          process.stderr.write(`ERROR: ${this.role} failed to open the session -> ${error instanceof Error ? error.message : String(error)}\n`);
          this.exitFn(error instanceof Error && "exitCode" in error && typeof (error as { exitCode: unknown }).exitCode === "number" ? (error as { exitCode: number }).exitCode : 2);
          return; // exitFn terminates the process; this line exists for control-flow clarity
        }
        this.channel.ack(msg.id);
        return;
      case "shutdown":
        await this.terminate("shutdown", 0);
        return;
      default:
        await this.handlers.onMessage(msg, this);
    }
  }

  sendHeartbeat(): void {
    const extra = this.handlers.heartbeat();
    this.channel.send("heartbeat", { turn_active: false, ...extra, last_event_id: this.lastEventId, pid: process.pid });
  }

  send<T extends MessageType>(type: T, payload: PayloadOf<T>, to: ProcId = "comm"): number {
    return this.channel.send(type, payload, to);
  }

  /**
   * Write-ahead event path (FR-03): sends the event; when `awaitAck` is set, waits for the Communicator's
   * acknowledgement. Alive-channel rule: a timeout with other traffic seen emits one WARNING event and waits
   * one more interval; a timeout without traffic terminates tool children (via the finalizer) and exits 4.
   */
  async sendEvent(event: AgentEvent, awaitAck: boolean): Promise<void> {
    const seq = this.channel.seq;
    const payload = { ...event, proc: event.proc ?? this.proc, run_ctx: this.runCtx, seq, prompt_id: this.promptId } as AgentEvent;
    if (!awaitAck) {
      this.lastEventId = this.channel.send("event", payload);
      return;
    }
    const id = this.channel.nextIdPreview;
    const sentAt = performance.now();
    const first = this.channel.sendAwaitAck("event", payload, this.ackTimeoutMs);
    this.lastEventId = id;
    try {
      await first;
      return;
    } catch (error) {
      if (!(error instanceof AckTimeout) || !error.otherTrafficSeen) return this.communicatorDead(error);
      this.channel.send("event", { ts: nowTs(), proc: this.proc, type: "error", message: `WARNING: slow acknowledgement: ${Math.round(performance.now() - sentAt)} ms`, run_ctx: this.runCtx, seq: this.channel.seq, prompt_id: this.promptId } as AgentEvent);
    }
    try {
      await this.channel.awaitAck(id, this.ackTimeoutMs, sentAt);
    } catch (error) {
      return this.communicatorDead(error);
    }
  }

  private async communicatorDead(error: unknown): Promise<never> {
    process.stderr.write(`ERROR: ${this.role} -> Communicator unresponsive -> ${error instanceof Error ? error.message : String(error)} -> exiting.\n`);
    await this.terminate("comm_dead", 4);
    throw error;
  }

  /** Runs the finalizer (bounded to 1 s for disconnect) and exits. */
  async terminate(reason: ShutdownReason, code: number): Promise<never> {
    if (this.shuttingDown) return new Promise<never>(() => {});
    this.shuttingDown = true;
    this.heartbeat.stop();
    const forceTimer = setTimeout(() => this.exitFn(code), reason === "disconnect" ? 900 : 2500);
    try {
      await this.handlers.onShutdown(reason, this);
    } catch (error) {
      process.stderr.write(`WARNING: ${this.role} finalizer failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    clearTimeout(forceTimer);
    return this.exitFn(code);
  }
}

/** Convenience for role entries: asserts the channel before any work (EC-14). */
export function assertSpawnedByCommunicator(role: ChildRole): void {
  if (!hasIpcChannel()) {
    throw new ConfigError(`--role ${role} must be spawned by the Communicator (no IPC channel).`, "Run 'hera' without --role.");
  }
}
