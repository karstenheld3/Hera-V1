// JSON-RPC 2.0 line connection for the ACP frontend (HERAV1ACP-SP01 FR-01, FR-11; HERAV1ACP-IP01 IS-01). Port of V1
// jsonrpc.py. stdout carries ONLY serialized JSON-RPC messages, one per line, through a bounded asynchronous write
// queue (10000 messages; overflow drops the oldest droppable notifications with one stderr line per burst). Agent- and
// client-originated request id spaces are independent; `pending` tracks agent-originated ids only. Nothing in this file
// writes to stdout except through the injected writer, and nothing here reads stdin except through `run()`.

import { dlog } from "../debug/debuglog.ts";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const REQUEST_CANCELLED = -32800;

export type JsonRpcId = number | string | null;
export type Params = Record<string, unknown>;

export interface Request {
  kind: "request";
  id: JsonRpcId;
  method: string;
  params: Params;
}
export interface Notification {
  kind: "notification";
  method: string;
  params: Params;
}
export interface Response {
  kind: "response";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export interface ParseFailure {
  kind: "parse_failure";
  /** -32700 for invalid JSON, -32600 for JSON that is not a JSON-RPC 2.0 message */
  code: typeof PARSE_ERROR | typeof INVALID_REQUEST;
  detail: string;
  /** the id of an invalid request when one was present */
  id: JsonRpcId;
}

export type Inbound = Request | Notification | Response | ParseFailure;

/** One stdin line → typed message or parse failure (EC-01). */
export function parseLine(line: string): Inbound {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch (error) {
    return { kind: "parse_failure", code: PARSE_ERROR, detail: error instanceof Error ? error.message : String(error), id: null };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { kind: "parse_failure", code: INVALID_REQUEST, detail: "not a JSON-RPC 2.0 object", id: null };
  const obj = data as Record<string, unknown>;
  const id: JsonRpcId = typeof obj["id"] === "number" || typeof obj["id"] === "string" ? obj["id"] : null;
  if (obj["jsonrpc"] !== "2.0") return { kind: "parse_failure", code: INVALID_REQUEST, detail: "missing 'jsonrpc': '2.0'", id };
  const params = typeof obj["params"] === "object" && obj["params"] !== null ? (obj["params"] as Params) : {};
  if (typeof obj["method"] === "string") {
    if ("id" in obj && obj["id"] !== null && obj["id"] !== undefined) return { kind: "request", id, method: obj["method"], params };
    return { kind: "notification", method: obj["method"], params };
  }
  if ("id" in obj && ("result" in obj || "error" in obj)) {
    const error = obj["error"];
    return { kind: "response", id, result: obj["result"], ...(typeof error === "object" && error !== null ? { error: error as Response["error"] } : {}) };
  }
  return { kind: "parse_failure", code: INVALID_REQUEST, detail: "neither request, notification, nor response", id };
}

/** Serializes one outbound message to a single line (embedded newlines are JSON-escaped). */
export function toLine(message: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...message });
}

export class ClientErrorResponse extends Error {
  constructor(readonly error: { code: number; message: string }) {
    super(error.message);
  }
}

export class RoundTripCancelled extends Error {}

export const WRITE_QUEUE_MAX = 10000;

/** Bounded async write queue: responses and requests are never dropped; notifications are droppable (oldest first). */
export class WriteQueue {
  private readonly queue: Array<{ line: string; droppable: boolean }> = [];
  private draining = false;
  private droppedInBurst = 0;
  dropped = 0;
  dead = false;
  /** Additional drop handler set by AcpServer for gap detection (FR-01). */
  onOverflow: ((count: number) => void) | undefined;
  constructor(
    private readonly write: (text: string) => Promise<void>,
    private readonly onDrop: (count: number) => void,
    private readonly max = WRITE_QUEUE_MAX,
  ) {}

  enqueue(line: string, droppable: boolean): void {
    if (this.dead) return;
    if (this.queue.length >= this.max) {
      const idx = this.queue.findIndex((q) => q.droppable);
      if (idx >= 0) {
        this.queue.splice(idx, 1);
        this.dropped++;
        this.droppedInBurst++;
      }
    }
    this.queue.push({ line, droppable });
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.dead) {
        const next = this.queue.shift() as { line: string; droppable: boolean };
        try {
          await this.write(`${next.line}\n`);
        } catch {
          this.dead = true;
          this.queue.length = 0;
          return;
        }
        if (this.queue.length === 0 && this.droppedInBurst > 0) {
          this.onDrop(this.droppedInBurst);
          this.onOverflow?.(this.droppedInBurst);
          this.droppedInBurst = 0;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    const deadline = performance.now() + 5000;
    while (!this.dead && (this.queue.length > 0 || this.draining) && performance.now() < deadline) await new Promise<void>((r) => setTimeout(r, 2));
  }
}

export interface ConnectionOptions {
  write: (text: string) => Promise<void>;
  stderr: (line: string) => void;
  maxQueue?: number;
}

interface PendingRequest {
  method: string;
  startedAt: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** One stdio link: reads client lines, writes agent lines, correlates agent-originated requests. */
export class AcpConnection {
  readonly writer: WriteQueue;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 100;
  private requestHandler: ((req: Request) => void) | undefined;
  private notificationHandler: ((n: Notification) => void) | undefined;
  /** outbound message counter per method (tests, acp turn lines) */
  readonly sentUpdates = { count: 0 };

  constructor(private readonly opts: ConnectionOptions) {
    this.writer = new WriteQueue(
      opts.write,
      (count) => {
        opts.stderr(`  WARNING: write queue overflow -> dropped ${count} session/update notifications.`);
        dlog("acp", "overflow", { dropped: count });
      },
      opts.maxQueue ?? WRITE_QUEUE_MAX,
    );
  }

  onRequest(handler: (req: Request) => void): void {
    this.requestHandler = handler;
  }

  onNotification(handler: (n: Notification) => void): void {
    this.notificationHandler = handler;
  }

  /** Notification to the client (droppable under overflow). */
  notify(method: string, params: Params): void {
    if (method === "session/update") this.sentUpdates.count++;
    this.writer.enqueue(toLine({ method, params }), true);
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.writer.enqueue(toLine({ id, result: result ?? {} }), false);
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.writer.enqueue(toLine({ id, error: { code, message } }), false);
  }

  /** Agent-to-client request; resolves with the result, rejects with ClientErrorResponse or RoundTripCancelled. */
  request(method: string, params: Params): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, startedAt: performance.now(), resolve, reject });
      this.writer.enqueue(toLine({ id, method, params }), false);
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Resolves every outstanding agent-originated request as cancelled (IG-05). */
  cancelPending(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      dlog("acp", "roundtrip", { method: p.method, dur_ms: Math.round(performance.now() - p.startedAt), outcome: "cancelled" });
      p.reject(new RoundTripCancelled(reason));
    }
  }

  private resolveResponse(res: Response): boolean {
    if (typeof res.id !== "number") return false;
    const p = this.pending.get(res.id);
    if (p === undefined) return false;
    this.pending.delete(res.id);
    if (res.error !== undefined) {
      dlog("acp", "roundtrip", { method: p.method, dur_ms: Math.round(performance.now() - p.startedAt), outcome: "client error" });
      p.reject(new ClientErrorResponse(res.error));
    } else {
      dlog("acp", "roundtrip", { method: p.method, dur_ms: Math.round(performance.now() - p.startedAt), outcome: "ok" });
      p.resolve(res.result);
    }
    return true;
  }

  /** Feeds one raw stdin line (CRLF tolerated); dispatches or answers with the wire error. */
  feed(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) return;
    const msg = parseLine(line);
    switch (msg.kind) {
      case "parse_failure":
        this.respondError(msg.id, msg.code, msg.code === PARSE_ERROR ? `Parse error: ${msg.detail}` : `Invalid Request: ${msg.detail}`);
        return;
      case "response":
        if (!this.resolveResponse(msg)) this.opts.stderr(`  WARNING: response for unknown request id ${JSON.stringify(msg.id)} ignored.`);
        return;
      case "request":
        dlog("acp", "recv", { method: msg.method, id: msg.id });
        if (this.requestHandler === undefined) this.respondError(msg.id, METHOD_NOT_FOUND, `Method not found: '${msg.method}'.`);
        else this.requestHandler(msg);
        return;
      case "notification":
        dlog("acp", "recv", { method: msg.method });
        this.notificationHandler?.(msg);
        return;
      default:
        return;
    }
  }

  /** Reads lines until EOF; returns when the source ends. */
  async run(lines: AsyncIterable<string>): Promise<void> {
    for await (const line of lines) this.feed(line);
  }
}
