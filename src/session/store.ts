// SessionStore: the Communicator-owned single writer of the session JSONL (HERAV1PROC-IP01 IS-05).
// Durability: flush = OS write returned (always); fsync on by default (harness.fsync: false downgrades durability to the OS page cache).
// Write failures propagate so the caller never acknowledges a line that is not on disk (EC-10).
// Implements EventSink (HERAV1HRNS-SP01 FR-07) - the default JsonlSink.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { toJsonl, type AgentEvent } from "../events.ts";

/** Abstraction over the session write target (HERAV1HRNS-SP01 FR-07). */
export interface EventSink {
  append(event: AgentEvent): void;
  readonly isOpen: boolean;
}

export type SessionMode = "new" | "resume";

export function newSessionId(date: Date = new Date()): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}_${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`;
  const suffix = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `${stamp}_${suffix}`;
}

export function sessionIdFromPath(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

export class SessionStore implements EventSink {
  readonly path: string;
  readonly sessionId: string;
  readonly mode: SessionMode;
  lines = 0;
  private fd: number | undefined;
  private readonly fsyncEnabled: boolean;

  private constructor(path: string, mode: SessionMode, fsync = false) {
    this.path = path;
    this.sessionId = sessionIdFromPath(path);
    this.mode = mode;
    this.fsyncEnabled = fsync;
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
  }

  /** Creates `data_dir/sessions/<id>.jsonl` (new) or reopens it for appending (resume). */
  static open(dataDir: string, mode: SessionMode, sessionId: string = newSessionId(), fsync = false): SessionStore {
    return new SessionStore(join(dataDir, "sessions", `${sessionId}.jsonl`), mode, fsync);
  }

  static openPath(path: string, mode: SessionMode, fsync = false): SessionStore {
    if (mode === "resume" && !existsSync(path)) throw new Error(`session file '${path}' does not exist.`);
    return new SessionStore(path, mode, fsync);
  }

  /** Appends one line and returns once the OS write returned; fsync if the profile requires it. */
  append(event: AgentEvent): void {
    if (this.fd === undefined) throw new Error(`session store '${this.path}' is closed.`);
    const line = `${toJsonl(event)}\n`;
    const bytes = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(this.fd, offset === 0 ? bytes : bytes.subarray(offset));
      if (written <= 0) throw new Error(`session store '${this.path}': write returned ${written}.`);
      offset += written;
    }
    if (this.fsyncEnabled) fsyncSync(this.fd);
    this.lines++;
  }

  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }

  get isOpen(): boolean {
    return this.fd !== undefined;
  }
}

/** Default EventSink implementation (HERAV1HRNS-SP01 FR-07). */
export const JsonlSink = SessionStore;
