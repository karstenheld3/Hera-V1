// Communicator core (HERAV1PROC-IP01 IS-08): spawns both children, owns the session JSONL, acknowledges after append,
// fans Executor traffic out to the Supervisor, relays cross-child messages, detects exits and restarts (FR-05..FR-09).
// IG-02: no handler awaits a child reply; the only awaits are the local store append and the startup handshake.

import type { ResolvedConfig } from "../config/load.ts";
import { dlog, writeReceived, type DebugLine } from "../debug/debuglog.ts";
import { nowTs, type AgentEvent } from "../events.ts";
import type { ChildRole, ProcId } from "../models.ts";
import { spawnChild, type SpawnChildOptions } from "../process/bootstrap.ts";
import type { IpcMessage, IpcMessageOf, MessageType, PayloadOf } from "../process/envelope.ts";
import { IpcChannel } from "../process/ipc.ts";
import { decideOnExit, newChildRecord, reapOrphans, shutdownAll, type ChildRecord, type ShutdownTarget } from "../process/lifecycle.ts";
import { SessionStore } from "../session/store.ts";
import { CommState, type StatusSnapshot } from "./state.ts";

export interface FrontendHooks {
  /** every appended event, in append order (Executor, Supervisor, and Communicator lines) */
  onEvent(event: AgentEvent): void;
  onAskUser(request: PayloadOf<"ask_user">): void;
  /** NOTICE: / WARNING: / ERROR: lines for stderr */
  onNotice(line: string): void;
  onTurnEnd?(): void;
  onStatusChange?(): void;
  onDebugLine?(line: PayloadOf<"debug_line">, from: ProcId): void;
  onReject?(from: ProcId, reason: string): void;
  /** When true, the frontend handles pending requests; when false, the Communicator auto-denies (fail-closed). */
  handlesPending?: boolean;
}

export type Spawner = (role: ChildRole, epoch: number, opts: SpawnChildOptions) => BunSubprocess;

export interface CommOptions {
  workspace: string;
  config: ResolvedConfig;
  /** existing JSONL path to resume; undefined = new session */
  resumePath?: string | undefined;
  env?: Record<string, string | undefined>;
  debugLines?: string | undefined;
  spawner?: Spawner;
  /** override the hello wait (tests) */
  helloTimeoutMs?: number;
  /** development-mode entry script for children (tests: src/index.ts) */
  entryMain?: string;
  /** ACP: spawn the children at start() but open the session later through openSession() (HERAV1ACP-SP01 FR-02, FR-03) */
  deferSession?: boolean;
}

export type SessionRequest = { mode: "new"; workspace: string } | { mode: "resume"; workspace: string; jsonlPath: string };

interface LiveChild {
  record: ChildRecord;
  channel: IpcChannel | undefined;
  subprocess: BunSubprocess | undefined;
  helloResolve: ((payload: PayloadOf<"hello">) => void) | undefined;
  helloReject: ((error: Error) => void) | undefined;
  ready: boolean;
  exitWaiters: Array<(code: number | null) => void>;
}

const RESUME_NOTE = "turn resumed after Executor restart";

export class Communicator {
  readonly state: CommState;
  private _store: SessionStore | undefined;
  private workspace: string;
  private switching = false;
  private readonly live: Partial<Record<ChildRole, LiveChild>> = {};
  private readonly spawner: Spawner;
  private readonly heartbeatMs: number;
  private silenceTimer: ReturnType<typeof setInterval> | undefined;
  private shuttingDown = false;
  private started = false;
  private executorStopped = false;
  private readonly heartbeatGapLatched: Record<ChildRole, boolean> = { executor: false, supervisor: false };
  private lastSummary = { sent: 0, received: 0, relayed: 0 };

  constructor(
    private readonly hooks: FrontendHooks,
    private readonly opts: CommOptions,
  ) {
    const dataDir = opts.config.dataDir;
    this.workspace = opts.workspace;
    const fsync = opts.config.config.harness.fsync;
    if (opts.deferSession !== true) this._store = opts.resumePath !== undefined ? SessionStore.openPath(opts.resumePath, "resume", fsync) : SessionStore.open(dataDir, "new", undefined, fsync);
    this.state = new CommState(this._store?.sessionId ?? "", this._store?.path ?? "", opts.config.config.ipc.restart_budget);
    this.spawner = opts.spawner ?? spawnChild;
    this.heartbeatMs = opts.config.config.ipc.heartbeat_s * 1000;
  }

  /** The session store; throws before openSession() in deferred mode. */
  get store(): SessionStore {
    if (this._store === undefined) throw new Error("no session open");
    return this._store;
  }

  get hasSession(): boolean {
    return this._store !== undefined;
  }

  get sessionId(): string {
    return this._store?.sessionId ?? "";
  }

  get currentWorkspace(): string {
    return this.workspace;
  }

  // ------------------------------------------------------------------ startup

  /** Spawns both children, awaits both hellos, sends session_open and awaits both acks (the only startup awaits). */
  async start(): Promise<void> {
    const [exec, sup] = await Promise.all([this.spawnAndHello("executor"), this.spawnAndHello("supervisor")]);
    if (this._store !== undefined) {
      await this.sendSessionOpenBoth(exec, sup, this._store.mode);
    }
    this.silenceTimer = setInterval(() => this.checkSupervisorSilence(), this.heartbeatMs);
    this.started = true;
    this.hooks.onStatusChange?.();
  }

  /** Sends session_open to both children and awaits acks; on failure reports which child exited. */
  private async sendSessionOpenBoth(exec: LiveChild, sup: LiveChild, mode: "new" | "resume"): Promise<void> {
    try {
      await Promise.all([this.sendSessionOpen(exec, mode), this.sendSessionOpen(sup, mode)]);
    } catch (error) {
      throw this.diagnoseChildExit(error);
    }
  }

  /** Returns a clear error if a child exited, otherwise rethrows the original error. */
  private diagnoseChildExit(error: unknown): Error {
    for (const role of ["executor", "supervisor"] as ChildRole[]) {
      const live = this.live[role];
      if (live !== undefined && live.record.state === "exited") {
        return new Error(`${role} exited during session open (code ${live.record.exitCode ?? "null"}). Check the error output above.`);
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Deferred-mode session open (ACP `session/new`, `session/load`): creates the store, sends `session_open` to both
   * children, resolves when both acknowledged. Never awaited by the event loop - the caller attaches a continuation.
   */
  openSession(req: SessionRequest): Promise<void> {
    if (this._store !== undefined) return Promise.reject(new Error(`session '${this._store.sessionId}' is already open - use switchSession()`));
    this.workspace = req.workspace;
    const fsync = this.opts.config.config.harness.fsync;
    this._store = req.mode === "resume" ? SessionStore.openPath(req.jsonlPath, "resume", fsync) : SessionStore.open(this.opts.config.dataDir, "new", undefined, fsync);
    this.state.sessionId = this._store.sessionId;
    this.state.jsonlPath = this._store.path;
    this.state.eventsAppended = 0;
    const opens: Promise<void>[] = [];
    for (const role of ["executor", "supervisor"] as ChildRole[]) {
      const live = this.live[role];
      if (live !== undefined && live.ready) opens.push(this.sendSessionOpen(live, req.mode));
    }
    dlog("app", "session", { file: this._store.path.replace(/^.*[\\/]/, ""), resumed: req.mode === "resume" });
    return Promise.all(opens).then(() => this.hooks.onStatusChange?.(), (error) => { throw this.diagnoseChildExit(error); });
  }

  /**
   * Session switch while idle (HERAV1ACP-SP01 FR-03, DD-09): closes the current JSONL, respawns both children (not
   * counted against the RestartBudget), opens the new session. Rejects while a turn is active.
   */
  async switchSession(req: SessionRequest): Promise<void> {
    if (this.state.turn.kind !== "idle") throw new Error(`a turn is active in session '${this.sessionId}'`);
    this.switching = true;
    try {
      this._store?.close();
      this._store = undefined;
      const exits: Promise<unknown>[] = [];
      for (const role of ["executor", "supervisor"] as ChildRole[]) {
        const live = this.live[role];
        if (live === undefined) continue;
        exits.push(
          new Promise<void>((resolve) => {
            if (live.record.state === "exited") {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              live.subprocess!.kill();
              resolve();
            }, this.opts.config.config.ipc.shutdown_timeout_ms);
            live.exitWaiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
            try {
              live.channel!.send("shutdown", { reason: "session switch" });
            } catch {
              live.subprocess!.kill();
            }
          }),
        );
      }
      await Promise.all(exits);
      this.state.interventions = {};
      this.state.promptsInFlight.clear();
      await Promise.all([this.spawnAndHello("executor"), this.spawnAndHello("supervisor")]);
      this.executorStopped = false;
      await this.openSession(req);
    } finally {
      this.switching = false;
    }
  }

  private spawnAndHello(role: ChildRole): Promise<LiveChild> {
    const epoch = this.state.nextEpoch(role);
    const record = newChildRecord(role, epoch);
    this.state.children[role] = record;
    const live: LiveChild = { record, channel: undefined, subprocess: undefined, helloResolve: undefined, helloReject: undefined, ready: false, exitWaiters: [] };
    const hello = new Promise<PayloadOf<"hello">>((resolve, reject) => {
      live.helloResolve = resolve;
      live.helloReject = reject;
    });
    const spawnStarted = performance.now();
    const subprocess = this.spawner(role, epoch, {
      cwd: this.workspace,
      env: this.opts.env,
      debugLines: this.opts.debugLines,
      main: this.opts.entryMain,
      onMessage: (raw) => live.channel?.dispatch(raw),
      onExit: (code, signal) => this.onChildExit(live, code, signal),
    });
    dlog("ipc", "spawn", { role, pid: subprocess.pid, epoch, dur_ms: Math.round((performance.now() - spawnStarted) * 10) / 10 });
    live.subprocess = subprocess;
    live.channel = new IpcChannel({ self: "comm", peer: record.proc, transport: { send: (m) => subprocess.send(m) }, onReject: (_raw, reason) => this.hooks.onReject?.(record.proc, reason) });
    live.channel.onMessage((msg) => this.route(live, msg));
    record.subprocess = subprocess;
    record.channel = live.channel;
    record.pid = subprocess.pid;
    this.live[role] = live;
    const timeoutMs = this.opts.helloTimeoutMs ?? this.opts.config.config.ipc.hello_timeout_ms;
    const timer = setTimeout(() => live.helloReject?.(new Error(`${role} sent no hello within ${timeoutMs} ms.`)), timeoutMs);
    return hello.then(
      (payload) => {
        clearTimeout(timer);
        record.pid = payload.pid;
        record.state = "ready";
        record.readyAt = performance.now();
        live.ready = true;
        dlog("ipc", "hello", { role, pid: payload.pid, ready_ms: Math.round(record.readyAt - spawnStarted), version: payload.version, standalone: payload.standalone });
        return live;
      },
      (error: Error) => {
        clearTimeout(timer);
        subprocess.kill();
        throw error;
      },
    );
  }

  private sendSessionOpen(live: LiveChild, mode: "new" | "resume"): Promise<void> {
    const cfg = this.opts.config;
    const payload: PayloadOf<"session_open"> = { session_id: this.store.sessionId, jsonl_path: this.store.path, mode, workspace: this.workspace, app_dir: cfg.appDir, config_path: cfg.configPath };
    // a resume projection may take longer than a plain append acknowledgement
    return live.channel!.sendAwaitAck("session_open", payload, Math.max(30000, cfg.config.ipc.ack_timeout_ms));
  }

  // ------------------------------------------------------------------ frontend API (never awaits a child)

  submitPrompt(text: string, note?: string): void {
    if (this.state.halted) {
      this.appendOwnEvent({ ts: nowTs(), proc: "comm", type: "error", message: "ERROR: run is halted - start a new session to continue." });
      return;
    }
    const payload: PayloadOf<"prompt"> = note !== undefined ? { text, note } : { text };
    this.state.startTurn(payload);
    if (this.executorStopped || this.live.executor === undefined || !this.live.executor.ready) {
      this.executorStopped = false;
      void this.respawn("executor", () => this.sendPrompt(payload));
      return;
    }
    this.sendPrompt(payload);
  }

  private sendPrompt(payload: PayloadOf<"prompt">): void {
    const exec = this.live.executor;
    if (exec === undefined) return;
    const msg = exec.channel!.sendReturning("prompt", payload);
    this.state.promptsInFlight.add(msg.id);
    this.copyToSupervisor(msg);
    this.hooks.onStatusChange?.();
  }

  answer(payload: PayloadOf<"answer">): void {
    this.live.executor?.channel?.send("answer", payload);
    this.state.answered();
    this.hooks.onStatusChange?.();
  }

  cancel(reason?: string): void {
    this.live.executor?.channel?.send("cancel", reason !== undefined ? { reason } : {});
  }

  /** Resolve a pending effect with a decision (FR-09). Called by the frontend after a human decision. */
  resolvePending(effect_id: string, decision: "allow" | "deny"): void {
    this.live.executor?.channel?.send("resolve", { effect_id, decision });
  }

  /** Sends halt to both children (FR-05). The frontend calls this on /halt or Ctrl+C. */
  halt(reason?: string): void {
    const payload = reason !== undefined ? { reason } : {};
    this.live.executor?.channel?.send("halt", payload);
    this.live.supervisor?.channel?.send("halt", payload);
  }

  continueDecision(proceed: boolean): void {
    this.live.executor?.channel?.send("continue", { proceed });
    this.state.answered();
  }

  status(): StatusSnapshot {
    return this.state.toStatusSnapshot();
  }

  /** Appends one Communicator-owned event line (`error`, `prompt_step`). */
  appendOwnEvent(event: AgentEvent): void {
    const stamped = { ...event, run_ctx: this.state.runCtx, seq: this.state.commSeq++, prompt_id: this.state.runCtx } as AgentEvent;
    this.appendAndNotify(stamped);
  }

  channelOf(role: ChildRole): IpcChannel | undefined {
    return this.live[role]?.channel;
  }

  // ------------------------------------------------------------------ dispatch

  private route(live: LiveChild, msg: IpcMessage): void {
    const role = live.record.role;
    if (msg.to !== "comm") {
      this.relayTo(msg.to, msg);
      return;
    }
    switch (msg.type) {
      case "hello":
        live.helloResolve?.(msg.payload);
        return;
      case "ack":
        return;
      case "heartbeat": {
        const gap = this.state.heartbeatAge(role);
        if (gap !== undefined && gap > 2 * this.heartbeatMs && !this.heartbeatGapLatched[role]) {
          this.heartbeatGapLatched[role] = true;
          dlog("ipc", "heartbeat_gap", { role, late_s: Math.round((gap - this.heartbeatMs) / 100) / 10, latched: true });
        } else if (gap !== undefined && gap <= 2 * this.heartbeatMs) this.heartbeatGapLatched[role] = false;
        this.state.recordHeartbeat(role, msg.payload);
        if (role === "executor") this.live.supervisor?.channel?.relay(msg);
        return;
      }
      case "event":
        this.onChildEvent(live, msg as IpcMessageOf<"event">);
        return;
      case "ask_user":
        this.state.waitForAnswer(msg.payload);
        if (msg.payload.kind === "pending" && this.hooks.handlesPending !== true) {
          // Fail-closed: no frontend handler registered → auto-deny
          const effectId = msg.payload.effect_id ?? "";
          if (effectId.length > 0) {
            live.channel?.send("resolve", { effect_id: effectId, decision: "deny" });
          }
        }
        this.hooks.onAskUser(msg.payload);
        this.hooks.onStatusChange?.();
        return;
      case "restart_request":
        this.hooks.onNotice(`NOTICE: Supervisor requested an Executor restart (${msg.payload.reason}).`);
        this.live.executor?.subprocess?.kill();
        return;
      case "admit_result": {
        if (msg.payload.status === "admitted" && msg.payload.run_ctx !== undefined) {
          this.state.runCtx = msg.payload.run_ctx;
          live.channel?.setRunCtx(msg.payload.run_ctx);
          dlog("ipc", "admit", { role, status: "admitted" });
        } else {
          dlog("ipc", "admit", { role, status: "refused", reason: msg.payload.reason });
          this.hooks.onNotice(`ERROR: ${role} admission refused: ${msg.payload.reason ?? "unknown"}`);
          this.appendAndNotify(this.ownError(`${role} admission refused: ${msg.payload.reason ?? "unknown"}`));
        }
        live.channel?.ack(msg.id);
        return;
      }
      case "halted": {
        const haltedEvent: AgentEvent = { ts: nowTs(), proc: msg.from, type: "halted", reason: msg.payload.reason, in_flight: msg.payload.in_flight, run_ctx: this.state.runCtx, seq: this.state.commSeq++, prompt_id: "" } as AgentEvent;
        this.appendAndNotify(haltedEvent);
        live.channel?.ack(msg.id);
        if (this.live.executor?.channel !== undefined && this.live.executor.channel === live.channel) {
          this.state.halted = true;
          this.state.endTurn();
          this.appendAndNotify(this.ownError("run halted"));
          this.hooks.onTurnEnd?.();
          this.hooks.onStatusChange?.();
        }
        return;
      }
      case "debug_line":
        writeReceived(msg.payload as DebugLine);
        this.hooks.onDebugLine?.(msg.payload, msg.from);
        return;
      default:
        this.hooks.onReject?.(msg.from, `unexpected message type '${msg.type}' addressed to the Communicator`);
    }
  }

  private onChildEvent(live: LiveChild, msg: IpcMessageOf<"event">): void {
    const event = msg.payload as AgentEvent;
    const arrivedAt = performance.now();
    try {
      this.store.append(event);
    } catch (error) {
      // no ack: the Executor's write-ahead wait decides (FR-03); the failure is visible on stderr
      this.hooks.onNotice(`ERROR: session store append failed -> ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    live.channel!.ack(msg.id);
    dlog("ipc", "ack", { ref: msg.id, event: event.type, from: msg.from, dur_ms: Math.round((performance.now() - arrivedAt) * 100) / 100 });
    if (live.record.role === "executor") this.copyToSupervisor(msg);
    this.state.eventsAppended++;
    this.trackEvent(event);
    this.hooks.onEvent(event);
  }

  private trackEvent(event: AgentEvent): void {
    switch (event.type) {
      case "tool_call_requested":
        this.state.countToolCall();
        break;
      case "supervisor_intervention":
        this.state.countIntervention(event.kind);
        break;
      case "turn_finished":
        if (event.proc === "exec") {
          this.turnSummary(false);
          this.state.endTurn();
          this.state.promptsInFlight.clear();
          this.hooks.onTurnEnd?.();
          this.hooks.onStatusChange?.();
        }
        break;
      default:
        break;
    }
  }

  private appendAndNotify(event: AgentEvent): void {
    try {
      this.store.append(event);
      this.state.eventsAppended++;
      this.hooks.onEvent(event);
    } catch (error) {
      this.hooks.onNotice(`ERROR: session store append failed -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private copyToSupervisor(msg: IpcMessage): void {
    const sup = this.live.supervisor;
    if (sup !== undefined && sup.ready && sup.record.state !== "exited") sup.channel?.relay(msg);
  }

  private relayTo(to: ProcId, msg: IpcMessage): void {
    const target = to === "exec" ? this.live.executor : to === "sup" ? this.live.supervisor : undefined;
    if (target === undefined || target.record.state === "exited") return; // the sender's own timeout decides (guards fail open)
    target.channel?.relay(msg);
  }

  // ------------------------------------------------------------------ exits and restarts (FR-06)

  private onChildExit(live: LiveChild, code: number | null, signal: string | null): void {
    const { record } = live;
    record.state = "exited";
    record.exitCode = code;
    record.signal = signal;
    record.exitedAt = performance.now();
    live.channel?.close("child exited"); // discards the dead child's pending items (RV01-RF-01)
    live.helloReject?.(new Error(`${record.role} exited before hello (code ${code ?? "null"}, signal ${signal ?? "null"}).`));
    for (const w of live.exitWaiters.splice(0)) w(code);
    if (this.live[record.role] === live) delete this.live[record.role];
    if (this.shuttingDown || this.switching || !this.started) return; // startup failures surface through start(), switches are deliberate
    const describe = signal !== null ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    const role = record.role;
    dlog("ipc", "exit", { role, code, signal, epoch: record.epoch, detect_ms: Math.round(record.exitedAt - (record.lastHeartbeatAt ?? record.exitedAt)) });
    if (role === "executor" && this.state.turn.kind !== "idle") this.turnSummary(true);
    this.appendAndNotify(this.ownError(`${role} exited: ${describe}`));
    if (role === "supervisor") {
      this.hooks.onNotice(`NOTICE: Supervisor exited (${describe}) -> respawning.`);
      void this.respawn("supervisor");
      this.hooks.onStatusChange?.();
      return;
    }
    const now = performance.now();
    const turnActive = this.state.turn.kind !== "idle";
    const action = decideOnExit({ turnActive, budget: this.state.budget, now });
    switch (action) {
      case "respawn_resume": {
        this.hooks.onNotice(`NOTICE: Executor exited (${describe}) -> restarting and resuming the turn.`);
        this.state.restartsThisSession++;
        const turn = this.state.turn;
        const prompt = turn.kind === "idle" ? undefined : turn.prompt;
        const restartStarted = performance.now();
        void this.respawn("executor", () => {
          if (prompt === undefined) return;
          dlog("ipc", "restart", { role: "executor", attempt: this.state.budget.turnRestartsUsed, budget: this.state.budget.perTurnMax, resume_ms: Math.round(performance.now() - restartStarted) });
          this.state.markResumed();
          this.appendAndNotify(this.ownError(`restart performed: Executor epoch ${this.state.children.executor.epoch}`));
          this.sendPrompt({ text: prompt.text, note: RESUME_NOTE });
        });
        break;
      }
      case "end_turn":
        this.appendAndNotify(this.ownError(`turn ended: Executor exited again (${describe}) and the restart budget (${this.state.budget.perTurnMax}) is exhausted`));
        this.hooks.onNotice(`ERROR: Executor exited twice in one turn (${describe}) -> turn ended; the next prompt spawns a fresh Executor.`);
        this.state.endTurn();
        this.executorStopped = true;
        this.hooks.onTurnEnd?.();
        break;
      case "respawn_idle":
        this.hooks.onNotice(`NOTICE: Executor exited while idle (${describe}) -> respawning.`);
        void this.respawn("executor");
        break;
      case "stop_idle":
        this.hooks.onNotice(`ERROR: Executor exited 4 times within 60 s while idle (last: ${describe}) -> not respawning until the next prompt.`);
        this.executorStopped = true;
        break;
      default:
        break;
    }
    this.hooks.onStatusChange?.();
  }

  private async respawn(role: ChildRole, afterOpen?: () => void): Promise<void> {
    if (this.shuttingDown) return;
    try {
      const live = await this.spawnAndHello(role);
      if (this._store !== undefined) await this.sendSessionOpen(live, "resume");
      afterOpen?.();
      this.hooks.onStatusChange?.();
    } catch (error) {
      if (this.shuttingDown) return;
      const diagnosed = this.diagnoseChildExit(error);
      this.hooks.onNotice(`ERROR: ${role} respawn failed -> ${diagnosed.message}`);
      if (role === "executor") {
        this.executorStopped = true;
        if (this.state.turn.kind !== "idle") {
          this.appendAndNotify(this.ownError(`turn ended: Executor respawn failed`));
          this.state.endTurn();
          this.hooks.onTurnEnd?.();
        }
      }
    }
  }

  private ownError(message: string): AgentEvent {
    return { ts: nowTs(), proc: "comm", type: "error", message, category: "process", run_ctx: this.state.runCtx, seq: this.state.commSeq++, prompt_id: "" } as AgentEvent;
  }

  /** One `ipc turn_summary` line per turn (DD-05: never per relayed message): counters and ack p99 since the previous summary. */
  private turnSummary(aborted: boolean): void {
    const exec = this.live.executor;
    const sup = this.live.supervisor;
    const sum = (c: Record<string, number> | undefined): number => (c === undefined ? 0 : Object.values(c).reduce((a, b) => a + b, 0));
    const sent = sum(exec?.channel?.sent) + sum(sup?.channel?.sent);
    const received = sum(exec?.channel?.received) + sum(sup?.channel?.received);
    const relayed = (exec?.channel?.relayed ?? 0) + (sup?.channel?.relayed ?? 0);
    const p99 = exec?.channel?.ackP99() ?? 0;
    dlog("ipc", "turn_summary", { sent: sent - this.lastSummary.sent, received: received - this.lastSummary.received, relayed: relayed - this.lastSummary.relayed, ack_p99_ms: Math.round(p99 * 100) / 100, aborted });
    this.lastSummary = { sent, received, relayed };
  }

  private checkSupervisorSilence(): void {
    const age = this.state.heartbeatAge("supervisor");
    const sup = this.live.supervisor;
    if (sup === undefined || !sup.ready) return;
    if (age !== undefined && age > 2 * this.heartbeatMs) {
      if (!this.state.supervisorSilentWarned) {
        this.state.supervisorSilentWarned = true;
        this.hooks.onNotice(`WARNING: supervisor silent (no heartbeat for ${Math.round(age / 1000)} s) - guards fail open until it recovers.`);
      }
    } else {
      this.state.supervisorSilentWarned = false;
    }
  }

  // ------------------------------------------------------------------ shutdown (FR-07)

  async shutdown(reason = "exit"): Promise<{ killed: ChildRole[]; orphansSurvived: number[] }> {
    this.shuttingDown = true;
    if (this.silenceTimer !== undefined) clearInterval(this.silenceTimer);
    const targets: ShutdownTarget[] = [];
    for (const role of ["executor", "supervisor"] as ChildRole[]) {
      const live = this.live[role];
      if (live === undefined) continue;
      targets.push({
        role,
        alive: () => live.record.state !== "exited",
        sendShutdown: () => {
          try {
            live.channel!.send("shutdown", { reason });
          } catch {
            /* channel gone */
          }
        },
        waitExit: (timeoutMs) =>
          new Promise<number | null | undefined>((resolve) => {
            if (live.record.state === "exited") {
              resolve(live.record.exitCode);
              return;
            }
            const timer = setTimeout(() => resolve(undefined), timeoutMs);
            live.exitWaiters.push((code) => {
              clearTimeout(timer);
              resolve(code);
            });
          }),
        kill: () => live.subprocess!.kill(),
        lastChildren: live.record.lastHeartbeat?.children ?? [],
      });
    }
    const shutdownStarted = performance.now();
    const result = await shutdownAll(targets, this.opts.config.config.ipc.shutdown_timeout_ms, (line) => this.hooks.onNotice(line));
    for (const t of targets) dlog("ipc", "shutdown", { role: t.role, wait_ms: Math.round(performance.now() - shutdownStarted), killed: result.killed.includes(t.role) });
    // a killed child cannot reap its own tool processes: sweep the last heartbeat lists once more
    for (const t of targets) if (t.role === "executor" && result.killed.includes("executor")) result.orphansSurvived.push(...reapOrphans(t.lastChildren));
    this._store?.close();
    return { killed: result.killed, orphansSurvived: result.orphansSurvived };
  }
}

export type { MessageType };
