// Communicator-local state (HERAV1PROC-IP01 IS-07). /status answers from here without any message to a child (FR-08).

import type { ChildRole } from "../models.ts";
import type { PayloadOf } from "../process/envelope.ts";
import { RestartBudget, newChildRecord, type ChildRecord } from "../process/lifecycle.ts";

export type TurnState =
  | { kind: "idle" }
  | { kind: "running"; since: number; toolCalls: number; prompt: PayloadOf<"prompt">; resumed: number }
  | { kind: "waiting_for_answer"; since: number; toolCalls: number; prompt: PayloadOf<"prompt">; resumed: number; ask: PayloadOf<"ask_user"> };

export interface ChildStatus {
  role: ChildRole;
  state: ChildRecord["state"];
  pid: number | undefined;
  epoch: number;
  heartbeatAgeMs: number | undefined;
  phase: string | undefined;
  exitCode: number | null;
  signal: string | null;
}

export interface StatusSnapshot {
  sessionId: string;
  jsonlPath: string;
  children: ChildStatus[];
  restartsThisSession: number;
  interventions: Record<string, number>;
  turn: TurnState["kind"];
  turnSinceMs: number | undefined;
  turnToolCalls: number;
  eventsAppended: number;
}

export class CommState {
  readonly children: Record<ChildRole, ChildRecord> = { executor: newChildRecord("executor", 0), supervisor: newChildRecord("supervisor", 0) };
  readonly budget: RestartBudget;
  restartsThisSession = 0;
  interventions: Record<string, number> = {};
  turn: TurnState = { kind: "idle" };
  eventsAppended = 0;
  supervisorSilentWarned = false;
  /** ids of `prompt` messages sent to the Executor for which no turn_finished arrived yet */
  readonly promptsInFlight = new Set<number>();
  /** Opaque run context from the latest admit() - stamped on every event and envelope (FR-06) */
  runCtx = "";
  /** Per-writer seq counter for Communicator-owned events (FR-06) */
  commSeq = 0;
  /** True when a halt has been issued and the run is in terminal state (FR-05) */
  halted = false;

  constructor(
    public sessionId: string,
    public jsonlPath: string,
    perTurnRestarts: number,
  ) {
    this.budget = new RestartBudget(perTurnRestarts);
  }

  nextEpoch(role: ChildRole): number {
    return this.children[role].epoch + 1;
  }

  startTurn(prompt: PayloadOf<"prompt">): void {
    this.turn = { kind: "running", since: performance.now(), toolCalls: 0, prompt, resumed: 0 };
    this.budget.turnStarted();
    this.budget.resetIdle();
  }

  endTurn(): void {
    this.turn = { kind: "idle" };
  }

  markResumed(): void {
    if (this.turn.kind === "idle") return;
    this.turn = { ...this.turn, kind: "running", resumed: this.turn.resumed + 1 } as TurnState;
  }

  waitForAnswer(ask: PayloadOf<"ask_user">): void {
    if (this.turn.kind === "idle") return;
    const { since, toolCalls, prompt, resumed } = this.turn;
    this.turn = { kind: "waiting_for_answer", since, toolCalls, prompt, resumed, ask };
  }

  answered(): void {
    if (this.turn.kind !== "waiting_for_answer") return;
    const { since, toolCalls, prompt, resumed } = this.turn;
    this.turn = { kind: "running", since, toolCalls, prompt, resumed };
  }

  countToolCall(): void {
    if (this.turn.kind !== "idle") this.turn.toolCalls++;
  }

  countIntervention(kind: string): void {
    this.interventions[kind] = (this.interventions[kind] ?? 0) + 1;
  }

  recordHeartbeat(role: ChildRole, payload: PayloadOf<"heartbeat">, now = performance.now()): void {
    const rec = this.children[role];
    rec.lastHeartbeat = payload;
    rec.lastHeartbeatAt = now;
  }

  heartbeatAge(role: ChildRole, now = performance.now()): number | undefined {
    const at = this.children[role].lastHeartbeatAt;
    return at === undefined ? undefined : now - at;
  }

  toStatusSnapshot(now = performance.now()): StatusSnapshot {
    const child = (role: ChildRole): ChildStatus => {
      const rec = this.children[role];
      return {
        role,
        state: rec.state,
        pid: rec.pid,
        epoch: rec.epoch,
        heartbeatAgeMs: this.heartbeatAge(role, now),
        phase: rec.lastHeartbeat?.phase,
        exitCode: rec.exitCode,
        signal: rec.signal,
      };
    };
    return {
      sessionId: this.sessionId,
      jsonlPath: this.jsonlPath,
      children: [child("executor"), child("supervisor")],
      restartsThisSession: this.restartsThisSession,
      interventions: { ...this.interventions },
      turn: this.turn.kind,
      turnSinceMs: this.turn.kind === "idle" ? undefined : now - this.turn.since,
      turnToolCalls: this.turn.kind === "idle" ? 0 : this.turn.toolCalls,
      eventsAppended: this.eventsAppended,
    };
  }
}
