// Lifecycle primitives (HERAV1PROC-IP01 IS-06): child records, the two-counter RestartBudget, the exit decision of
// FR-06, ordered shutdown with per-step timeout (FR-07), and best-effort orphan termination (RV01-RF-11).
// The Communicator core (communicator/main.ts) executes these decisions; nothing here awaits a child reply.

import type { ChildRole, ProcId } from "../models.ts";
import type { PayloadOf } from "./envelope.ts";
import type { IpcChannel } from "./ipc.ts";

export type ChildState = "spawning" | "ready" | "exited";

export interface ChildRecord {
  role: ChildRole;
  proc: ProcId;
  epoch: number;
  state: ChildState;
  subprocess: BunSubprocess | undefined;
  channel: IpcChannel | undefined;
  pid: number | undefined;
  spawnedAt: number;
  readyAt: number | undefined;
  lastHeartbeatAt: number | undefined;
  lastHeartbeat: PayloadOf<"heartbeat"> | undefined;
  exitCode: number | null;
  signal: string | null;
  exitedAt: number | undefined;
}

export function newChildRecord(role: ChildRole, epoch: number): ChildRecord {
  return {
    role,
    proc: role === "executor" ? "exec" : "sup",
    epoch,
    state: "spawning",
    subprocess: undefined,
    channel: undefined,
    pid: undefined,
    spawnedAt: performance.now(),
    readyAt: undefined,
    lastHeartbeatAt: undefined,
    lastHeartbeat: undefined,
    exitCode: null,
    signal: null,
    exitedAt: undefined,
  };
}

/** Two counters (spec section 3 RestartBudget): per turn (`ipc.restart_budget`) and idle (3 per 60 s). */
export class RestartBudget {
  private turnUsed = 0;
  private idleExitTimes: number[] = [];

  constructor(
    readonly perTurnMax: number,
    readonly idleMax = 3,
    readonly idleWindowMs = 60000,
  ) {}

  turnStarted(): void {
    this.turnUsed = 0;
  }

  /** true when an automatic restart is still allowed in the current turn (and consumes one). */
  tryConsumeTurn(): boolean {
    if (this.turnUsed >= this.perTurnMax) return false;
    this.turnUsed++;
    return true;
  }

  get turnRestartsUsed(): number {
    return this.turnUsed;
  }

  /** true when an idle respawn is allowed (fewer than idleMax exits inside the window) and records this exit. */
  tryConsumeIdle(now: number): boolean {
    this.idleExitTimes = this.idleExitTimes.filter((t) => now - t < this.idleWindowMs);
    this.idleExitTimes.push(now);
    return this.idleExitTimes.length <= this.idleMax;
  }

  get idleExhausted(): boolean {
    return this.idleExitTimes.length > this.idleMax;
  }

  /** the next user prompt re-arms idle respawns (FR-06) */
  resetIdle(): void {
    this.idleExitTimes = [];
  }
}

export type ExitAction = "respawn_resume" | "end_turn" | "respawn_idle" | "stop_idle";

/** FR-06 decision for an Executor exit. Pure: the caller performs the action. */
export function decideOnExit(ctx: { turnActive: boolean; budget: RestartBudget; now: number }): ExitAction {
  if (ctx.turnActive) return ctx.budget.tryConsumeTurn() ? "respawn_resume" : "end_turn";
  return ctx.budget.tryConsumeIdle(ctx.now) ? "respawn_idle" : "stop_idle";
}

export interface ShutdownTarget {
  role: ChildRole;
  alive(): boolean;
  sendShutdown(): void;
  waitExit(timeoutMs: number): Promise<number | null | undefined>;
  kill(): void;
  /** pids from the child's last heartbeat `children` list */
  lastChildren: number[];
}

export interface ShutdownResult {
  killed: ChildRole[];
  exitCodes: Partial<Record<ChildRole, number | null>>;
  orphansSurvived: number[];
}

/** FR-07: Executor first (it owns tool children), then Supervisor; each step bounded by `timeoutMs`. */
export async function shutdownAll(targets: ShutdownTarget[], timeoutMs: number, log: (line: string) => void = () => {}): Promise<ShutdownResult> {
  const ordered = [...targets].sort((a, b) => (a.role === "executor" ? -1 : b.role === "executor" ? 1 : 0));
  const result: ShutdownResult = { killed: [], exitCodes: {}, orphansSurvived: [] };
  for (const target of ordered) {
    if (!target.alive()) {
      result.exitCodes[target.role] = null;
      continue;
    }
    target.sendShutdown();
    const code = await target.waitExit(timeoutMs);
    if (code === undefined) {
      target.kill();
      result.killed.push(target.role);
      result.exitCodes[target.role] = null;
      log(`WARNING: ${target.role} did not exit within ${timeoutMs} ms -> killed.`);
    } else {
      result.exitCodes[target.role] = code;
    }
    if (target.role === "executor" && target.lastChildren.length > 0) {
      const survivors = reapOrphans(target.lastChildren);
      result.orphansSurvived.push(...survivors);
      if (survivors.length > 0) log(`WARNING: tool child processes still alive after shutdown: ${survivors.join(", ")}.`);
    }
  }
  return result;
}

/** Best-effort termination of tool child pids; returns the pids that survived. */
export function reapOrphans(pids: number[]): number[] {
  const survivors: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue; // already gone
    }
    try {
      process.kill(pid, 0);
      survivors.push(pid);
    } catch {
      /* terminated */
    }
  }
  return survivors;
}
