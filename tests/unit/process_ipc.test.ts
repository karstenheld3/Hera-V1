import { describe, expect, test } from "bun:test";
import { nowTs } from "../../src/events.ts";
import type { IpcMessage } from "../../src/process/envelope.ts";
import { AckTimeout, HeartbeatTimer, IpcChannel, InboundQueue, type Transport } from "../../src/process/ipc.ts";

/** In-memory pair of transports delivering asynchronously in send order (the channel property IPC provides). */
function pair(): { a: IpcChannel; b: IpcChannel; aRejects: string[]; bRejects: string[] } {
  const aRejects: string[] = [];
  const bRejects: string[] = [];
  let aDispatch: ((raw: unknown) => void) | undefined;
  let bDispatch: ((raw: unknown) => void) | undefined;
  const ta: Transport = { send: (m) => queueMicrotask(() => bDispatch?.(JSON.parse(JSON.stringify(m)))) };
  const tb: Transport = { send: (m) => queueMicrotask(() => aDispatch?.(JSON.parse(JSON.stringify(m)))) };
  const a = new IpcChannel({ self: "comm", peer: "exec", transport: ta, onReject: (_raw, reason) => aRejects.push(reason) });
  const b = new IpcChannel({ self: "exec", peer: "comm", transport: tb, onReject: (_raw, reason) => bRejects.push(reason) });
  aDispatch = (raw) => a.dispatch(raw);
  bDispatch = (raw) => b.dispatch(raw);
  return { a, b, aRejects, bRejects };
}

const textEvent = () => ({ ts: nowTs(), proc: "exec" as const, type: "text_delta" as const, text: "x" });

describe("HERAV1PROC-TP01 channel", () => {
  test("HERAV1PROC-IP01-TC-02 sendAwaitAck resolves on matching ack and ignores non-matching acks", async () => {
    const { a, b } = pair();
    a.onMessage((msg) => {
      if (msg.type === "event") {
        a.ack(999); // non-matching first
        a.ack(msg.id);
      }
    });
    await b.sendAwaitAck("event", textEvent(), 1000);
    expect(b.ackLatencies).toHaveLength(1);
    expect(b.pendingAckCount).toBe(0);
  });

  test("HERAV1PROC-IP01-TC-03 AckTimeout carries otherTrafficSeen", async () => {
    const silent = pair();
    silent.a.onMessage(() => {});
    let error: unknown;
    try {
      await silent.b.sendAwaitAck("event", textEvent(), 40);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AckTimeout);
    expect((error as AckTimeout).otherTrafficSeen).toBe(false);

    const chatty = pair();
    chatty.a.onMessage((msg) => {
      if (msg.type === "event") chatty.a.send("heartbeat", { turn_active: false, last_event_id: 0, pid: 1 });
    });
    chatty.b.onMessage(() => {});
    let error2: unknown;
    try {
      await chatty.b.sendAwaitAck("event", textEvent(), 40);
    } catch (e) {
      error2 = e;
    }
    expect(error2).toBeInstanceOf(AckTimeout);
    expect((error2 as AckTimeout).otherTrafficSeen).toBe(true);
  });

  test("HERAV1PROC-IP01-TC-04 relay forwards id, from, ts byte-identical and counts", async () => {
    const { a, b } = pair();
    const received: IpcMessage[] = [];
    b.onMessage((m) => received.push(m));
    const original: IpcMessage = { v: 1, id: 77, from: "sup", to: "exec", type: "inject", ts: "2026-01-15 10:00:00.000", run_ctx: "", seq: 0, payload: { kind: "memory", text: "test" } };
    a.relay(original);
    await Bun.sleep(5);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(original);
    expect(a.relayed).toBe(1);
    expect(a.nextIdPreview).toBe(1); // relay does not consume the sender's sequence
  });

  test("HERAV1PROC-IP01-TC-05 ids start at 1 per sender; counters per type match sent and received", async () => {
    const { a, b } = pair();
    a.onMessage(() => {});
    b.onMessage(() => {});
    expect(b.send("hello", { role: "executor", pid: 1, version: "2.0.0", standalone: false, epoch: 1 })).toBe(1);
    expect(b.send("heartbeat", { turn_active: false, last_event_id: 0, pid: 1 })).toBe(2);
    expect(b.send("heartbeat", { turn_active: false, last_event_id: 0, pid: 1 })).toBe(3);
    a.send("shutdown", {});
    await Bun.sleep(5);
    expect(b.sent["hello"]).toBe(1);
    expect(b.sent["heartbeat"]).toBe(2);
    expect(a.received["hello"]).toBe(1);
    expect(a.received["heartbeat"]).toBe(2);
    expect(a.sent["shutdown"]).toBe(1);
    expect(b.received["shutdown"]).toBe(1);
  });

  test("invalid inbound objects are rejected with a reason, never thrown", async () => {
    const { a, b, aRejects } = pair();
    a.onMessage(() => {});
    (b as unknown as { transport: Transport }).transport.send({ v: 2, id: 1, from: "exec", to: "comm", type: "shutdown", ts: "t", payload: {} });
    (b as unknown as { transport: Transport }).transport.send({ nonsense: true });
    await Bun.sleep(5);
    expect(aRejects).toHaveLength(2);
    expect(aRejects[0]).toContain("version");
  });

  test("HERAV1PROC-IP01-TC-06 HeartbeatTimer.beatNow emits immediately and the periodic timer continues", async () => {
    let beats = 0;
    const timer = new HeartbeatTimer(30, () => beats++);
    timer.start();
    expect(beats).toBe(0);
    timer.beatNow();
    expect(beats).toBe(1);
    await Bun.sleep(100);
    timer.stop();
    expect(beats).toBeGreaterThanOrEqual(3);
    const after = beats;
    await Bun.sleep(50);
    expect(beats).toBe(after);
  });

  test("HERAV1HRNS-TP01-TC-16: seq is monotonic per writer and independent per process", async () => {
    const { a, b } = pair();
    a.onMessage(() => {});
    b.onMessage(() => {});
    a.setRunCtx("ctx_a");
    b.setRunCtx("ctx_b");
    a.send("heartbeat", { turn_active: false, last_event_id: 0, pid: 1 });
    a.send("heartbeat", { turn_active: false, last_event_id: 0, pid: 1 });
    a.send("shutdown", {});
    b.send("heartbeat", { turn_active: false, last_event_id: 0, pid: 1 });
    b.send("shutdown", {});
    await Bun.sleep(10);
    expect(a.seq).toBe(3);
    expect(b.seq).toBe(2);
    expect(a.seq).not.toBe(b.seq);
  });
});

describe("HERAV1HRNS-TP01-TC-17: InboundQueue control priority and display overflow", () => {
  function mkMsg(type: string, id: number): IpcMessage {
    return { v: 1, id, from: "exec" as const, to: "comm" as const, type: type as never, ts: nowTs(), run_ctx: "", seq: id, payload: {} } as IpcMessage;
  }

  test("control messages (halt, admit_result, resolve, ack) are processed before display messages", async () => {
    const q = new InboundQueue(100);
    const order: string[] = [];
    q.setHandler((msg) => { order.push(msg.type); });
    // Enqueue display messages first, then a control message
    q.enqueue(mkMsg("event", 1));
    q.enqueue(mkMsg("event", 2));
    q.enqueue(mkMsg("event", 3));
    q.enqueue(mkMsg("halt", 4));
    q.enqueue(mkMsg("event", 5));
    await Bun.sleep(10);
    // halt (control) should be processed before event 5 (display)
    expect(order.indexOf("halt")).toBeLessThan(order.indexOf("event") + 3);
    // halt should come before the 4th event
    const eventPositions = order.map((t, i) => t === "event" ? i : -1).filter((i) => i >= 0);
    expect(eventPositions[3]).toBeDefined();
    expect(order[eventPositions[3] as number]).toBe("event");
    expect(order.indexOf("halt")).toBeLessThan(eventPositions[3] as number);
  });

  test("display overflow drops oldest display messages but never drops control messages", async () => {
    const q = new InboundQueue(3);
    const received: string[] = [];
    q.setHandler((msg) => { received.push(msg.type); });
    // Fill display queue to capacity
    q.enqueue(mkMsg("event", 1));
    q.enqueue(mkMsg("event", 2));
    q.enqueue(mkMsg("event", 3));
    // This should drop event 1 (oldest display)
    q.enqueue(mkMsg("event", 4));
    // Control messages are never dropped
    q.enqueue(mkMsg("halt", 5));
    q.enqueue(mkMsg("resolve", 6));
    q.enqueue(mkMsg("admit_result", 7));
    await Bun.sleep(10);
    expect(q.dropped).toBe(1);
    // All control messages must be received
    expect(received).toContain("halt");
    expect(received).toContain("resolve");
    expect(received).toContain("admit_result");
    // event 1 should have been dropped
    const eventIds = received.filter((t) => t === "event").length;
    expect(eventIds).toBe(3); // events 2, 3, 4 survived
  });

  test("IpcChannel.queue prioritizes halt over event messages", async () => {
    const { a, b } = pair();
    const order: string[] = [];
    a.onMessage((msg) => { order.push(msg.type); });
    // Send events first, then halt, then another event
    b.send("event", textEvent());
    b.send("event", textEvent());
    b.send("event", textEvent());
    b.send("halt", { reason: "test" });
    b.send("event", textEvent());
    await Bun.sleep(20);
    // halt (control) is processed before all display messages
    const haltIdx = order.indexOf("halt");
    expect(haltIdx).toBe(0); // halt is first
    expect(order.length).toBe(5); // 4 events + 1 halt
    // all events come after halt
    expect(order.slice(1).every((t) => t === "event")).toBe(true);
  });
});
