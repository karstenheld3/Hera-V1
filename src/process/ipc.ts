// IpcChannel: envelope-aware wrapper over one parent-child channel (HERAV1PROC-IP01 IS-02).
// Both sides use the same class: the parent wraps a Subprocess, the child wraps process.send.

import { IpcError } from "../errors.ts";
import { nowTs } from "../events.ts";
import type { ProcId } from "../models.ts";
import { PROTOCOL_VERSION } from "../version.ts";
import { MESSAGE_TYPES, validate, type IpcMessage, type IpcMessageOf, type MessageType, type PayloadOf } from "./envelope.ts";

export interface Transport {
  send(message: unknown): void;
}

/** Message types that get priority in the inbound queue (FR-07). */
const CONTROL_TYPES = new Set<MessageType>(["halt", "admit_result", "resolve", "ack"]);

/**
 * Bounded inbound queue with priority for control messages (FR-07, FR-08).
 * Control lane: unbounded (never drops; slow sink pauses dispatch).
 * Display lane: bounded (drops oldest when full).
 * Processing: all control messages first, then display; new control preempts display.
 */
export class InboundQueue {
  private readonly control: IpcMessage[] = [];
  private readonly display: IpcMessage[] = [];
  private displayDropped = 0;
  private processing = false;
  private handler: ((msg: IpcMessage) => void) | undefined;
  private readonly onHandlerError: ((msg: IpcMessage, error: unknown) => void) | undefined;
  private readonly displayMax: number;

  constructor(displayMax = 1000, onHandlerError?: (msg: IpcMessage, error: unknown) => void) {
    this.displayMax = displayMax;
    this.onHandlerError = onHandlerError;
  }

  setHandler(handler: (msg: IpcMessage) => void): void {
    this.handler = handler;
  }

  get size(): number { return this.control.length + this.display.length; }
  get dropped(): number { return this.displayDropped; }
  get controlSize(): number { return this.control.length; }
  get displaySize(): number { return this.display.length; }

  enqueue(msg: IpcMessage): void {
    if (CONTROL_TYPES.has(msg.type)) {
      this.control.push(msg);
    } else {
      if (this.display.length >= this.displayMax) {
        this.display.shift();
        this.displayDropped++;
      }
      this.display.push(msg);
    }
    if (!this.processing) {
      this.processing = true;
      queueMicrotask(() => this.drain());
    }
  }

  private drain(): void {
    this.processing = false;
    const h = this.handler;
    if (h === undefined) return;
    // Process all control messages first
    while (this.control.length > 0) {
      const msg = this.control.shift()!;
      try { h(msg); } catch (error) { this.onHandlerError?.(msg, error); }
    }
    // Then process display messages, checking for new control messages
    while (this.display.length > 0) {
      if (this.control.length > 0) {
        while (this.control.length > 0) {
          const msg = this.control.shift()!;
          try { h(msg); } catch (error) { this.onHandlerError?.(msg, error); }
        }
      }
      const msg = this.display.shift()!;
      try { h(msg); } catch (error) { this.onHandlerError?.(msg, error); }
    }
  }
}

export class AckTimeout extends IpcError {
  readonly ref: number;
  readonly otherTrafficSeen: boolean;
  readonly waitedMs: number;

  constructor(ref: number, waitedMs: number, otherTrafficSeen: boolean) {
    super(
      `no acknowledgement for message ${ref} within ${waitedMs} ms (${otherTrafficSeen ? "channel alive, peer slow" : "no traffic from the peer"}).`,
      otherTrafficSeen ? "The peer is alive but slow; waiting one more interval." : "Treat the peer as dead.",
    );
    this.ref = ref;
    this.otherTrafficSeen = otherTrafficSeen;
    this.waitedMs = waitedMs;
  }
}

type Counters = Record<MessageType, number>;

function zeroCounters(): Counters {
  const out = {} as Counters;
  for (const t of MESSAGE_TYPES) out[t] = 0;
  return out;
}

interface PendingAck {
  resolve(): void;
  reject(error: AckTimeout): void;
  sentAt: number;
  inboundAtSend: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface IpcChannelOptions {
  self: ProcId;
  peer: ProcId;
  transport: Transport;
  onReject?(raw: unknown, reason: string): void;
}

export class IpcChannel {
  readonly self: ProcId;
  readonly peer: ProcId;
  readonly sent: Counters = zeroCounters();
  readonly received: Counters = zeroCounters();
  relayed = 0;
  readonly ackLatencies: number[] = [];
  /** number of inbound messages of any type (the alive-channel rule of FR-03 compares this before and after a wait) */
  inboundCount = 0;
  lastInboundAt: number | undefined;
  /** Monotonic per-writer sequence number (FR-06, independent per process) */
  seq = 0;
  /** Opaque run context from admit() - stamped on every envelope (FR-06) */
  runCtx = "";
  private readonly transport: Transport;
  private readonly onReject: ((raw: unknown, reason: string) => void) | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingAck>();
  /** acks that arrived with no waiter (bounded) - lets awaitAck() be called after the ack already came in */
  private readonly unmatchedAcks = new Set<number>();
  private closed = false;
  /** Bounded inbound queue with priority for control messages (FR-07, FR-08). */
  readonly queue: InboundQueue;

  constructor(opts: IpcChannelOptions) {
    this.self = opts.self;
    this.peer = opts.peer;
    this.transport = opts.transport;
    this.onReject = opts.onReject;
    this.queue = new InboundQueue(1000, (msg, error) => {
      this.onReject?.(msg, `handler threw: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  get nextIdPreview(): number {
    return this.nextId;
  }

  get pendingAckCount(): number {
    return this.pending.size;
  }

  onMessage(handler: (msg: IpcMessage) => void): void {
    this.queue.setHandler(handler);
  }

  /** Entry point for raw channel objects (spawn `ipc` callback or process.on("message")). Never throws. */
  dispatch(raw: unknown): void {
    if (this.closed) return;
    const result = validate(raw);
    if (!result.ok) {
      this.onReject?.(raw, result.reason);
      return;
    }
    const msg = result.msg;
    this.inboundCount++;
    this.lastInboundAt = performance.now();
    this.received[msg.type]++;
    if (msg.type === "ack") {
      const ref = (msg.payload as PayloadOf<"ack">).ref;
      const pending = this.pending.get(ref);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(ref);
        this.ackLatencies.push(performance.now() - pending.sentAt);
        if (this.ackLatencies.length > 1000) this.ackLatencies.shift();
        pending.resolve();
      } else {
        this.unmatchedAcks.add(ref);
        if (this.unmatchedAcks.size > 1000) this.unmatchedAcks.delete(this.unmatchedAcks.values().next().value as number);
      }
    }
    this.queue.enqueue(msg);
  }

  send<T extends MessageType>(type: T, payload: PayloadOf<T>, to: ProcId = this.peer): number {
    return this.sendReturning(type, payload, to).id;
  }

  /** Like send() but returns the full message, so a byte-identical copy can be relayed elsewhere (FR-05 fan-out). */
  sendReturning<T extends MessageType>(type: T, payload: PayloadOf<T>, to: ProcId = this.peer): IpcMessageOf<T> {
    const id = this.nextId++;
    const seq = this.seq++;
    const msg: IpcMessageOf<T> = { v: PROTOCOL_VERSION, id, from: this.self, to, type, ts: nowTs(), run_ctx: this.runCtx, seq, payload };
    this.transport.send(msg);
    this.sent[type]++;
    return msg;
  }

  /** Registers a waiter for the ack of an already-sent message (also succeeds when the ack arrived earlier). */
  awaitAck(id: number, timeoutMs: number, sentAt: number = performance.now()): Promise<void> {
    if (this.unmatchedAcks.delete(id)) {
      this.ackLatencies.push(performance.now() - sentAt);
      if (this.ackLatencies.length > 1000) this.ackLatencies.shift();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const inboundAtSend = this.inboundCount;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AckTimeout(id, timeoutMs, this.inboundCount > inboundAtSend));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, sentAt, inboundAtSend, timer });
    });
  }

  sendAwaitAck<T extends MessageType>(type: T, payload: PayloadOf<T>, timeoutMs: number, to: ProcId = this.peer): Promise<void> {
    const id = this.nextId++;
    const seq = this.seq++;
    const msg: IpcMessageOf<T> = { v: PROTOCOL_VERSION, id, from: this.self, to, type, ts: nowTs(), run_ctx: this.runCtx, seq, payload };
    const promise = this.awaitAck(id, timeoutMs);
    this.transport.send(msg);
    this.sent[type]++;
    return promise;
  }

  ack(ref: number, to: ProcId = this.peer): void {
    this.send("ack", { ref }, to);
  }

  /** Forwards a message unchanged (same id, from, ts, run_ctx, seq) - the Communicator's relay (FR-02, IG-05). */
  relay(msg: IpcMessage): void {
    this.transport.send(msg);
    this.relayed++;
  }

  /** Sets the run_ctx from admit() - stamped on every subsequent envelope (FR-06). */
  setRunCtx(runCtx: string): void {
    this.runCtx = runCtx;
  }

  ackP99(): number | undefined {
    if (this.ackLatencies.length === 0) return undefined;
    const sorted = [...this.ackLatencies].sort((x, y) => x - y);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  }

  /** Rejects every pending acknowledgement and stops accepting input (used when the peer exited). */
  close(reason = "channel closed"): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new AckTimeout(id, 0, false));
    }
    this.pending.clear();
    void reason;
  }
}

/** Periodic heartbeat with an immediate extra beat on demand (FR-04). */
export class HeartbeatTimer {
  private handle: ReturnType<typeof setInterval> | undefined;
  private intervalMs: number;

  constructor(intervalMs: number, private readonly beat: () => void) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.stop();
    this.handle = setInterval(() => this.beat(), this.intervalMs);
    unrefTimer(this.handle);
  }

  setInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.handle !== undefined) this.start();
  }

  beatNow(): void {
    this.beat();
  }

  stop(): void {
    if (this.handle !== undefined) clearInterval(this.handle);
    this.handle = undefined;
  }
}

/** Bun timers expose unref(); the DOM typings do not, hence the cast. */
export function unrefTimer(handle: unknown): void {
  const t = handle as { unref?: () => void } | undefined;
  if (t !== undefined && typeof t.unref === "function") t.unref();
}
