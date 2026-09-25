// SinkRouter - routes native events to the configured EventSink (HERAV1HRNS-SP01 FR-07).
// The Communicator creates a SinkRouter wrapping the SessionStore (default JsonlSink).
// Children emit events via IPC; the Communicator routes them through the SinkRouter.

import type { AgentEvent } from "../events.ts";
import type { EventSink } from "../session/store.ts";

/** Emit function type for pre-dispatch event acknowledgement. */
export type EmitFn = (event: AgentEvent, awaitAck?: boolean) => Promise<void>;

/** Routes native events to the configured sink (HERAV1HRNS-SP01 FR-07). */
export class SinkRouter {
  private readonly sink: EventSink | undefined;

  constructor(sink: EventSink | undefined) {
    this.sink = sink;
  }

  append(event: AgentEvent): void {
    this.sink?.append(event);
  }

  get isOpen(): boolean {
    return this.sink?.isOpen ?? false;
  }

  get hasSink(): boolean {
    return this.sink !== undefined;
  }
}
