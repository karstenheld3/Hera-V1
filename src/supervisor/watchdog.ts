// Stall watchdog (HERAV1SUPV-SP01 FR-03; HERAV1SUPV-IP01 IS-03). Heartbeats and event copies tell "alive but silent"
// from "dead"; a first stall resumes the Executor, a second one in the same turn (or a missed resume) requests a restart.
// The Supervisor never sends cancel.

import { dlog } from "../debug/debuglog.ts";
import type { AgentEvent } from "../events.ts";
import type { PayloadOf } from "../process/envelope.ts";

export interface WatchdogConfig {
  stallTimeoutMs: number;
  heartbeatMs: number;
}

export interface WatchdogActions {
  resume(payload: { reason: "frozen" | "tool_hang"; phase: string }): void;
  restartRequest(reason: string): void;
  intervention(kind: "stall_resume" | "restart_request", text: string): void;
}

export type StallKind = "frozen" | "tool_hang";

/** Parses the heartbeat `phase_since` (`YYYY-MM-DD HH:MM:SS.mmm`) into epoch ms; undefined when absent or malformed. */
export function parsePhaseSince(ts: string | undefined): number | undefined {
  if (ts === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(ts);
  if (m === null) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] ?? 0)).getTime();
}

export class StallWatchdog {
  private lastBeatAt: number | undefined;
  private lastEventAt: number | undefined;
  private turnActive = false;
  private phase: string = "idle";
  private phaseSinceMs: number | undefined;
  private phaseSeenAt: number | undefined;
  private resumesThisTurn = 0;
  private pendingResumeDeadline: number | undefined;
  private resumeSentAt: number | undefined;
  private restartRequested = false;
  lastTurnUsage: PayloadOf<"heartbeat">["turn_usage"] | undefined;

  constructor(
    private readonly cfg: WatchdogConfig,
    private readonly actions: WatchdogActions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  onHeartbeat(payload: PayloadOf<"heartbeat">): void {
    const t = this.now();
    this.lastBeatAt = t;
    this.turnActive = payload.turn_active;
    const phase = payload.phase ?? "idle";
    if (phase !== this.phase || this.phaseSeenAt === undefined) {
      this.phase = phase;
      this.phaseSeenAt = t;
    }
    this.phaseSinceMs = parsePhaseSince(payload.phase_since) ?? this.phaseSeenAt;
    if (payload.turn_usage !== undefined) this.lastTurnUsage = payload.turn_usage;
  }

  onEvent(event: AgentEvent): void {
    const t = this.now();
    if (event.proc === "exec") this.lastEventAt = t;
    if (event.type === "user_message" && event.proc === "exec") {
      this.turnActive = true;
      this.resumesThisTurn = 0;
      this.restartRequested = false;
      this.pendingResumeDeadline = undefined;
    } else if (event.type === "turn_finished" && event.proc === "exec" && event.role === "generating") {
      this.turnActive = false;
      this.pendingResumeDeadline = undefined;
    } else if (event.type === "executor_resumed") {
      if (this.resumeSentAt !== undefined) dlog("sup", "resumed", { reason: event.reason, recovery_ms: Math.round(t - this.resumeSentAt) });
      this.resumeSentAt = undefined;
      this.pendingResumeDeadline = undefined;
      if (event.reason === "restart") this.reset();
    }
  }

  /** Milliseconds since the last heartbeat or event (0 when none seen). */
  silentMs(): number {
    const lastSign = Math.max(this.lastBeatAt ?? 0, this.lastEventAt ?? 0);
    return lastSign > 0 ? this.now() - lastSign : 0;
  }

  /** Executor exit (Communicator error line) or restart: a new Executor starts with zero resumes. */
  reset(): void {
    this.lastBeatAt = undefined;
    this.lastEventAt = undefined;
    this.turnActive = false;
    this.phase = "idle";
    this.phaseSinceMs = undefined;
    this.phaseSeenAt = undefined;
    this.resumesThisTurn = 0;
    this.pendingResumeDeadline = undefined;
    this.restartRequested = false;
  }

  get state(): { turnActive: boolean; phase: string; resumesThisTurn: number; awaitingResume: boolean } {
    return { turnActive: this.turnActive, phase: this.phase, resumesThisTurn: this.resumesThisTurn, awaitingResume: this.pendingResumeDeadline !== undefined };
  }

  /** Called every heartbeat interval. Returns the action taken (for tests and debug lines). */
  tick(): "none" | "resume" | "restart" {
    const t = this.now();
    if (this.restartRequested) return "none";
    if (this.pendingResumeDeadline !== undefined && t > this.pendingResumeDeadline) {
      this.escalate(`Executor did not confirm the resume within ${Math.round((2 * this.cfg.heartbeatMs) / 1000)} s`);
      return "restart";
    }
    if (!this.turnActive) return "none";
    const lastSign = Math.max(this.lastBeatAt ?? 0, this.lastEventAt ?? 0);
    const frozen = lastSign > 0 && t - lastSign > this.cfg.stallTimeoutMs;
    const hung = this.phase === "tool_call" && this.phaseSinceMs !== undefined && t - this.phaseSinceMs > this.cfg.stallTimeoutMs;
    if (!frozen && !hung) return "none";
    if (this.pendingResumeDeadline !== undefined) return "none"; // waiting for the resume confirmation
    const kind: StallKind = hung ? "tool_hang" : "frozen";
    if (this.resumesThisTurn >= 1) {
      this.escalate(kind === "tool_hang" ? `tool still running after a resume (${Math.round((t - (this.phaseSinceMs ?? t)) / 1000)} s)` : `Executor silent again for ${Math.round((t - lastSign) / 1000)} s after a resume`);
      return "restart";
    }
    this.resumesThisTurn++;
    this.pendingResumeDeadline = t + 2 * this.cfg.heartbeatMs;
    this.resumeSentAt = t;
    const text = kind === "tool_hang" ? `tool call running for ${Math.round((t - (this.phaseSinceMs ?? t)) / 1000)} s without completion - resuming the Executor` : `Executor silent for ${Math.round((t - lastSign) / 1000)} s (no heartbeat, no event) - resuming`;
    this.actions.resume({ reason: kind, phase: this.phase });
    this.actions.intervention("stall_resume", text);
    if (kind === "tool_hang") this.phaseSinceMs = t; // the terminated tool no longer counts
    return "resume";
  }

  private escalate(reason: string): void {
    this.restartRequested = true;
    this.pendingResumeDeadline = undefined;
    this.actions.restartRequest(reason);
    this.actions.intervention("restart_request", `${reason} - requesting an Executor restart`);
  }
}
