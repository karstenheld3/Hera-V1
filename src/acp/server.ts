// ACP server (HERAV1ACP-SP01 FR-02..FR-05, FR-10, FR-11; HERAV1ACP-IP01 IS-02, IS-03). Port of V1 server.py over the
// Communicator core: handshake state, session/new and session/load with deferred responses completed from the
// session_open acknowledgements, session/prompt completed from later events, session/cancel, $/cancel_request.
// IG-06: no handler awaits an IPC reply - every handler registers a continuation and returns.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CostLedger } from "../cli/cost.ts";
import { formatStatus } from "../cli/builtins.ts";
import type { Communicator } from "../communicator/core.ts";
import type { ResolvedConfig } from "../config/load.ts";
import { dlog } from "../debug/debuglog.ts";
import { nowTs, type AgentEvent } from "../events.ts";
import type { PayloadOf } from "../process/envelope.ts";
import { projectSession } from "../session/projection.ts";
import { VERSION } from "../version.ts";
import { ContinueBroker, ElicitationBroker, PermissionBroker } from "./brokers.ts";
import { AcpConnection, INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, REQUEST_CANCELLED, type JsonRpcId, type Notification, type Params, type Request } from "./connection.ts";
import { EventTranslator } from "./translator.ts";

export const PROTOCOL_VERSION = 1;

export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AcpServerDeps {
  connection: AcpConnection;
  comm: Communicator;
  config: ResolvedConfig;
  ledger: CostLedger;
  workflows: Array<{ name: string; description: string }>;
  stderr: (line: string) => void;
  /** injected clock for tests */
  now?: () => number;
}

interface PendingPrompt {
  id: JsonRpcId;
  sessionId: string;
  startedAt: number;
  updatesAtStart: number;
  cancelWithError: boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
}

export function initializeResult(): Record<string, unknown> {
  return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "hera", version: VERSION }, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } } };
}

/** FR-05 baseline: text verbatim, resource_link inlined; capability-gated block types → -32602 naming the type. */
export function assemblePromptText(params: Params): string {
  const blocks = params["prompt"];
  if (!Array.isArray(blocks) || blocks.length === 0) throw new AcpError(INVALID_PARAMS, "Prompt contains no content blocks.");
  const parts: string[] = [];
  for (const block of blocks as Array<Record<string, unknown>>) {
    const type = typeof block["type"] === "string" ? block["type"] : "unknown";
    if (type === "text") parts.push(typeof block["text"] === "string" ? block["text"] : "");
    else if (type === "resource_link") {
      const uri = typeof block["uri"] === "string" ? block["uri"] : "";
      const name = typeof block["name"] === "string" && block["name"].length > 0 ? block["name"] : uri;
      parts.push(`[resource: ${name}](${uri})`);
    } else throw new AcpError(INVALID_PARAMS, `Unsupported content block type '${type}' - this agent accepts 'text' and 'resource_link' (promptCapabilities: image/audio/embeddedContext all false).`);
  }
  const text = parts.filter((p) => p.length > 0).join("\n");
  if (text.trim().length === 0) throw new AcpError(INVALID_PARAMS, "Prompt contains no text content.");
  return text;
}

export class AcpServer {
  state: "uninitialized" | "initialized" | "shutdown" = "uninitialized";
  private initializeResultSent: Record<string, unknown> | undefined;
  readonly translator: EventTranslator;
  readonly continueBroker: ContinueBroker;
  readonly permissionBroker: PermissionBroker;
  readonly elicitationBroker: ElicitationBroker;
  private pendingPrompt: PendingPrompt | undefined;
  private sessionOpening = false;
  private readonly now: () => number;
  /** Monotonic counter for session/update notifications (FR-01 gap detection). */
  private updateSeq = 0;
  /** Set when the WriteQueue drops notifications; next onEvent replays from JSONL. */
  private gapDetected = false;
  /** Last tool call ID from `tool_call_requested` (U09: permission broker needs it for `session/request_permission`). */
  private lastToolCallId = "";

  constructor(private readonly deps: AcpServerDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.translator = new EventTranslator({ ledger: deps.ledger, contextWindow: deps.config.roles.generating.contextWindow ?? 0, stderr: deps.stderr });
    const brokerDeps = { connection: deps.connection, comm: deps.comm, sessionId: () => deps.comm.sessionId, stderr: deps.stderr, warn: (text: string) => this.warnChunk(text) };
    this.continueBroker = new ContinueBroker(brokerDeps);
    this.permissionBroker = new PermissionBroker(brokerDeps);
    this.elicitationBroker = new ElicitationBroker(brokerDeps);
    deps.connection.onRequest((req) => this.handleRequest(req));
    deps.connection.onNotification((n) => this.handleNotification(n));
    // FR-01: when the WriteQueue drops notifications, flag for resync
    deps.connection.writer.onOverflow = (count: number) => {
      this.gapDetected = true;
      this.deps.stderr(`  WARNING: notification gap detected - ${count} session/update notifications dropped; resync will be sent.`);
    };
  }

  // ------------------------------------------------------------------ router

  private handleRequest(req: Request): void {
    const started = this.now();
    const done = (status: string): void => {
      if (req.method !== "session/prompt") dlog("acp", "send", { method: req.method, id: req.id, dur_ms: Math.round(this.now() - started), status });
    };
    try {
      switch (req.method) {
        case "initialize":
          this.handleInitialize(req);
          done("ok");
          return;
        default:
          break;
      }
      if (this.state !== "initialized") throw new AcpError(INVALID_REQUEST, `'${req.method}' rejected: handshake incomplete - send initialize first.`);
      switch (req.method) {
        case "session/new":
          this.handleSessionNew(req, started);
          return;
        case "session/load":
          this.handleSessionLoad(req, started);
          return;
        case "session/prompt":
          this.handleSessionPrompt(req);
          return;
        default:
          throw new AcpError(METHOD_NOT_FOUND, `Method not found: '${req.method}'.`);
      }
    } catch (error) {
      if (error instanceof AcpError) {
        this.deps.connection.respondError(req.id, error.code, error.message);
        done(`error ${error.code}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.stderr(`  ERROR: ${req.method}: ${message}`);
      this.deps.connection.respondError(req.id, INTERNAL_ERROR, message);
      done(`error ${INTERNAL_ERROR}`);
    }
  }

  private handleNotification(n: Notification): void {
    try {
      switch (n.method) {
        case "initialized":
          return; // MCP/LSP habit, not part of ACP - tolerated silently
        case "session/cancel":
          this.handleSessionCancel(n.params);
          return;
        case "$/cancel_request":
          this.handleCancelRequest(n.params);
          return;
        default:
          this.deps.stderr(`  WARNING: unknown notification '${n.method}' ignored.`);
      }
    } catch (error) {
      this.deps.stderr(`  ERROR: notification ${n.method} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------------ initialize (FR-02)

  private handleInitialize(req: Request): void {
    const clientInfo = (req.params["clientInfo"] ?? {}) as { name?: string; version?: string };
    if (this.state === "initialized" && this.initializeResultSent !== undefined) {
      this.deps.stderr("  NOTICE: initialize received again -> answered identically.");
      this.deps.connection.respond(req.id, this.initializeResultSent);
      return;
    }
    this.elicitationBroker.formSupported = ElicitationBroker.formSupportedFrom(req.params["clientCapabilities"]);
    this.initializeResultSent = initializeResult();
    this.deps.connection.respond(req.id, this.initializeResultSent);
    this.state = "initialized";
    const requested = req.params["protocolVersion"];
    this.deps.stderr(`initialize: client '${`${clientInfo.name ?? "unknown"} ${clientInfo.version ?? ""}`.trim()}', requested protocolVersion ${String(requested ?? "[UNKNOWN]")}, negotiated ${PROTOCOL_VERSION}, elicitation.form ${this.elicitationBroker.formSupported ? "yes" : "no"}.`);
  }

  // ------------------------------------------------------------------ sessions (FR-03, FR-04)

  private requireIdle(method: string): void {
    if (this.pendingPrompt !== undefined || this.deps.comm.status().turn !== "idle") throw new AcpError(INVALID_REQUEST, `${method} rejected: a prompt turn is active in session '${this.deps.comm.sessionId}'.`);
    if (this.sessionOpening) throw new AcpError(INVALID_REQUEST, `${method} rejected: a session is still opening.`);
  }

  private warnIgnored(params: Params): void {
    if (Array.isArray(params["mcpServers"]) && params["mcpServers"].length > 0) this.deps.stderr("  WARNING: 'mcpServers' ignored - Hera has no MCP client.");
    if (Array.isArray(params["additionalDirectories"]) && params["additionalDirectories"].length > 0) this.deps.stderr("  WARNING: 'additionalDirectories' ignored - Hera has a single-workspace model.");
  }

  private requireCwd(params: Params, method: string): string {
    const cwd = params["cwd"];
    if (typeof cwd !== "string" || cwd.length === 0) throw new AcpError(INVALID_PARAMS, `${method} requires 'cwd' (absolute workspace path).`);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new AcpError(INVALID_PARAMS, `${method}: 'cwd' '${cwd}' does not exist or is not a directory.`);
    return cwd;
  }

  private handleSessionNew(req: Request, started: number): void {
    this.requireIdle("session/new");
    const cwd = this.requireCwd(req.params, "session/new");
    this.warnIgnored(req.params);
    const comm = this.deps.comm;
    const open = comm.hasSession ? comm.switchSession({ mode: "new", workspace: cwd }) : comm.openSession({ mode: "new", workspace: cwd });
    this.sessionOpening = true;
    void open
      .then(() => {
        this.sessionOpening = false;
        const sessionId = comm.sessionId;
        this.deps.connection.respond(req.id, { sessionId });
        this.sendAvailableCommands(sessionId);
        const status = comm.status();
        if (this.deps.config.config.harness.profile === "passthrough") {
          this.deps.stderr("WARNING: profile passthrough - no guards, no approvals");
        }
        this.deps.stderr(`session/new: created '${sessionId}' in '${cwd}' (executor pid='${status.children[0]?.pid ?? "[UNKNOWN]"}', supervisor pid='${status.children[1]?.pid ?? "[UNKNOWN]"}').`);
        dlog("acp", "send", { method: "session/new", id: req.id, dur_ms: Math.round(this.now() - started), status: "ok" });
      })
      .catch((error: unknown) => {
        this.sessionOpening = false;
        const message = error instanceof Error ? error.message : String(error);
        this.deps.connection.respondError(req.id, INVALID_PARAMS, `session/new failed -> ${message}`);
        dlog("acp", "send", { method: "session/new", id: req.id, dur_ms: Math.round(this.now() - started), status: `error ${INVALID_PARAMS}` });
      });
  }

  private handleSessionLoad(req: Request, started: number): void {
    this.requireIdle("session/load");
    const cwd = this.requireCwd(req.params, "session/load");
    this.warnIgnored(req.params);
    const sessionId = typeof req.params["sessionId"] === "string" ? req.params["sessionId"] : "";
    const sessionsDir = join(this.deps.config.dataDir, "sessions");
    const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);
    if (sessionId.length === 0 || !/^[A-Za-z0-9_.-]+$/.test(sessionId) || !existsSync(jsonlPath)) throw new AcpError(INVALID_PARAMS, `Unknown sessionId '${sessionId}' -> no session file in '${sessionsDir}'.`);
    const comm = this.deps.comm;
    // replay from the Communicator's own projection BEFORE the response completes the load (FR-04)
    const projection = projectSession(jsonlPath);
    if (projection.legacy) this.deps.stderr(`  WARNING: session '${sessionId}' has no session_started line - loading with disk assembly.`);
    for (const w of projection.warnings) this.deps.stderr(`  ${w}`);
    this.deps.ledger.rebuild(projection);
    const replayer = new EventTranslator({ ledger: this.deps.ledger, contextWindow: this.deps.config.roles.generating.contextWindow ?? 0, replaying: true, stderr: () => undefined });
    let replayed = 0;
    for (const update of replayer.replay(projection)) {
      this.updateSeq++;
      this.deps.connection.notify("session/update", { sessionId, seq: this.updateSeq, update });
      replayed++;
    }
    const open = comm.hasSession ? comm.switchSession({ mode: "resume", workspace: cwd, jsonlPath }) : comm.openSession({ mode: "resume", workspace: cwd, jsonlPath });
    this.sessionOpening = true;
    void open
      .then(() => {
        this.sessionOpening = false;
        this.deps.connection.respond(req.id, {});
        this.sendAvailableCommands(sessionId);
        this.deps.stderr(`session/load: '${sessionId}' - ${replayed} updates replayed.`);
        dlog("acp", "send", { method: "session/load", id: req.id, dur_ms: Math.round(this.now() - started), status: "ok", replayed });
      })
      .catch((error: unknown) => {
        this.sessionOpening = false;
        const message = error instanceof Error ? error.message : String(error);
        this.deps.connection.respondError(req.id, INVALID_PARAMS, `session/load failed -> ${message}`);
        dlog("acp", "send", { method: "session/load", id: req.id, dur_ms: Math.round(this.now() - started), status: `error ${INVALID_PARAMS}` });
      });
  }

  private sendAvailableCommands(sessionId: string): void {
    const commands = [...this.deps.workflows.map((w) => ({ name: w.name, description: w.description })), { name: "status", description: "Communicator status: processes, restarts, interventions, turn state" }, { name: "cost", description: "Per-role cost totals of this session" }];
    this.updateSeq++;
    this.deps.connection.notify("session/update", { sessionId, seq: this.updateSeq, update: { sessionUpdate: "available_commands_update", availableCommands: commands } });
  }

  /** FR-01: replay the JSONL to resync the client after a notification gap. */
  private resyncFromJsonl(): void {
    if (!this.deps.comm.hasSession) return;
    const sessionId = this.deps.comm.sessionId;
    const jsonlPath = join(this.deps.config.dataDir, "sessions", `${sessionId}.jsonl`);
    if (!existsSync(jsonlPath)) return;
    const projection = projectSession(jsonlPath);
    const replayer = new EventTranslator({ ledger: this.deps.ledger, contextWindow: this.deps.config.roles.generating.contextWindow ?? 0, replaying: true, stderr: () => undefined });
    this.deps.stderr(`  resync: replaying ${projection.events.length} events from JSONL.`);
    for (const update of replayer.replay(projection)) {
      this.updateSeq++;
      this.deps.connection.notify("session/update", { sessionId, seq: this.updateSeq, update });
    }
  }

  private requireSession(params: Params): string {
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : "";
    if (!this.deps.comm.hasSession || sessionId !== this.deps.comm.sessionId) throw new AcpError(INVALID_PARAMS, `Unknown sessionId '${sessionId}'. Create one with session/new or load one with session/load.`);
    return sessionId;
  }

  // ------------------------------------------------------------------ prompt turn (FR-05)

  private handleSessionPrompt(req: Request): void {
    const sessionId = this.requireSession(req.params);
    if (this.pendingPrompt !== undefined || this.deps.comm.status().turn !== "idle") throw new AcpError(INVALID_REQUEST, `A prompt turn is already active for session '${sessionId}' (one turn per session).`);
    const text = assemblePromptText(req.params);
    const trimmed = text.trim();
    if (trimmed === "/status" || trimmed === "/cost") {
      const lines = trimmed === "/status" ? formatStatus(this.deps.comm.status(), { queuedPrompt: undefined, restartBudgetLeft: Math.max(0, this.deps.comm.state.budget.perTurnMax - this.deps.comm.state.budget.turnRestartsUsed) }) : this.deps.ledger.costTable();
      this.updateSeq++;
      this.deps.connection.notify("session/update", { sessionId, seq: this.updateSeq, update: { sessionUpdate: "agent_message_chunk", messageId: this.translator.messageId, content: { type: "text", text: lines.join("\n") } } });
      this.deps.connection.respond(req.id, { stopReason: "end_turn" });
      dlog("acp", "turn", { id: req.id, dur_ms: 0, stop: "end_turn", updates: 1, builtin: trimmed });
      return;
    }
    this.pendingPrompt = { id: req.id, sessionId, startedAt: this.now(), updatesAtStart: this.deps.connection.sentUpdates.count, cancelWithError: false };
    this.deps.comm.submitPrompt(text);
  }

  private finishPrompt(kind: "result" | "error", payload: string | { code: number; message: string }): void {
    const pending = this.pendingPrompt;
    if (pending === undefined) return;
    this.pendingPrompt = undefined;
    if (pending.cancelTimer !== undefined) clearTimeout(pending.cancelTimer);
    const updates = this.deps.connection.sentUpdates.count - pending.updatesAtStart;
    if (kind === "result") {
      this.deps.connection.respond(pending.id, { stopReason: payload as string });
      dlog("acp", "turn", { id: pending.id, dur_ms: Math.round(this.now() - pending.startedAt), stop: payload, updates });
      this.deps.stderr(`session/prompt: ${payload as string}.`);
    } else {
      const err = payload as { code: number; message: string };
      this.deps.connection.respondError(pending.id, err.code, err.message);
      dlog("acp", "turn", { id: pending.id, dur_ms: Math.round(this.now() - pending.startedAt), stop: `error ${err.code}`, updates });
      this.deps.stderr(`session/prompt: error -> ${err.message}`);
    }
  }

  // ------------------------------------------------------------------ hooks from the Communicator

  onEvent(event: AgentEvent): void {
    const pending = this.pendingPrompt;
    if (pending === undefined && event.type === "error") {
      // outside a prompt turn (session open notices, idle restarts) the client expects no updates: stderr only
      this.deps.stderr(`  ${event.message}`);
      return;
    }
    // FR-01: if notifications were dropped, resync by replaying the JSONL
    if (this.gapDetected && this.deps.comm.hasSession) {
      this.gapDetected = false;
      this.resyncFromJsonl();
    }
    if (this.deps.comm.hasSession) {
      const sessionId = this.deps.comm.sessionId;
      for (const update of this.translator.translate(event)) {
        this.updateSeq++;
        this.deps.connection.notify("session/update", { sessionId, seq: this.updateSeq, update });
      }
    }
    if (event.type === "tool_call_requested" && typeof (event as Record<string, unknown>).id === "string") this.lastToolCallId = (event as Record<string, unknown>).id as string;
    if (pending === undefined) return;
    if (event.type === "turn_finished" && event.proc === "exec" && event.role === "generating") {
      if (pending.cancelWithError) this.finishPrompt("error", { code: REQUEST_CANCELLED, message: "Request cancelled." });
      else this.finishPrompt("result", event.stop_reason === "cancelled" ? "cancelled" : "end_turn");
    } else if (event.type === "error" && event.proc === "exec" && event.category === "provider") {
      this.finishPrompt("error", { code: INTERNAL_ERROR, message: event.message });
    } else if (event.type === "error" && event.proc === "comm" && /^turn ended/.test(event.message)) {
      this.finishPrompt("error", { code: INTERNAL_ERROR, message: event.message });
    } else if (event.type === "halted") {
      this.finishPrompt("error", { code: INTERNAL_ERROR, message: `Run halted: ${event.reason ?? "unknown"}` });
    }
  }

  onAskUser(req: PayloadOf<"ask_user">): void {
    if (req.kind === "pending") {
      void this.permissionBroker.handle(req, this.lastToolCallId);
      return;
    }
    if (req.kind === "continue") void this.continueBroker.handle(req);
    else void this.elicitationBroker.handle(req);
  }

  onTurnEnd(): void {
    // a turn that ended without turn_finished (restart budget exhausted, respawn failure) is answered by the comm error line
  }

  /** U09: Send a WARNING agent message chunk to the client (used by PermissionBroker on deny+warning fallback). */
  private warnChunk(text: string): void {
    if (!this.deps.comm.hasSession) return;
    this.updateSeq++;
    this.deps.connection.notify("session/update", { sessionId: this.deps.comm.sessionId, seq: this.updateSeq, update: { sessionUpdate: "agent_message_chunk", messageId: this.translator.messageId, content: { type: "text", text } } });
  }

  // ------------------------------------------------------------------ cancellation (FR-10)

  private handleSessionCancel(params: Params): void {
    const pending = this.pendingPrompt;
    if (pending === undefined || (typeof params["sessionId"] === "string" && params["sessionId"] !== pending.sessionId)) {
      this.deps.stderr("  session/cancel: no active turn - ignored.");
      return;
    }
    this.startCancel(pending, false);
  }

  private startCancel(pending: PendingPrompt, withError: boolean): void {
    if (pending.cancelTimer !== undefined) clearTimeout(pending.cancelTimer);
    pending.cancelWithError = withError;
    this.deps.connection.cancelPending(withError ? "$/cancel_request" : "session/cancel");
    this.deps.comm.cancel(withError ? "$/cancel_request" : "session/cancel");
    dlog("acp", withError ? "cancel_request" : "cancel", { id: pending.id });
    const timeoutMs = this.deps.config.config.ipc.shutdown_timeout_ms;
    pending.cancelTimer = setTimeout(() => {
      if (this.pendingPrompt !== pending) return;
      this.deps.comm.appendOwnEvent({ ts: nowTs(), proc: "comm", type: "error", message: `WARNING: Executor did not confirm the cancellation within ${timeoutMs} ms - the turn is treated as stalled.`, category: "process" });
      this.deps.comm.state.endTurn();
      if (withError) this.finishPrompt("error", { code: REQUEST_CANCELLED, message: "Request cancelled." });
      else this.finishPrompt("result", "cancelled");
    }, timeoutMs);
  }

  private handleCancelRequest(params: Params): void {
    const requestId = params["requestId"] ?? params["id"];
    const pending = this.pendingPrompt;
    if (pending !== undefined && pending.id === requestId) {
      this.startCancel(pending, true);
      return;
    }
    this.deps.stderr(`  $/cancel_request: no cancellable request with id ${JSON.stringify(requestId)} - ignored.`);
  }

  /** stdin EOF (FR-01): cancel the active turn, resolve client requests, then the caller runs the shutdown order. */
  onEof(): void {
    this.state = "shutdown";
    dlog("acp", "eof", {});
    if (this.pendingPrompt !== undefined) {
      this.deps.connection.cancelPending("stdin EOF");
      this.deps.comm.cancel("stdin EOF");
      this.finishPrompt("result", "cancelled");
    }
    this.deps.stderr("stdin EOF - ACP server shutting down.");
  }

  get activePromptId(): JsonRpcId | undefined {
    return this.pendingPrompt?.id;
  }
}
