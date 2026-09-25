// Event renderer and status line (HERAV1CLI-SP01 FR-01, FR-07; HERAV1CLI-IP01 IS-03). Port of V1 render.py to
// picocolors. In jsonl mode every event is one JSONL line on stdout and every notice goes to stderr.

import { pc, createColors, type Colors } from "../colors.ts";
import { toJsonl, type AgentEvent, type ErrorSeverity } from "../events.ts";
import type { CostLedger } from "./cost.ts";

export interface RendererOptions {
  showThinking: boolean;
  jsonl: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  ledger?: CostLedger;
  /** disable the ticking status line (tests, non-TTY) */
  statusLine?: boolean;
  colors?: boolean;
}

const PRIMARY_ARGS = ["CommandLine", "file_path", "TargetFile", "DirectoryPath", "SearchPath", "Url", "SkillName", "query", "document_id", "ID", "question"];

export function summarizeArgs(args: Record<string, unknown>): string {
  for (const key of PRIMARY_ARGS) {
    if (key in args) return String(args[key]).slice(0, 120);
  }
  return "";
}

/** Ticks elapsed seconds between turn_started and the first visible output. */
export class StatusLine {
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private visible = false;

  constructor(private readonly write: (text: string) => void) {}

  start(): void {
    this.stop();
    this.startedAt = performance.now();
    this.timer = setInterval(() => {
      const s = Math.floor((performance.now() - this.startedAt) / 1000);
      this.write(`\r${pc.dim(`thinking... ${s}s`)}`);
      this.visible = true;
    }, 1000);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.visible) {
      this.write("\r\u001b[2K");
      this.visible = false;
    }
  }

  get active(): boolean {
    return this.timer !== undefined;
  }
}

export class Renderer {
  private streaming = false;
  private readonly status: StatusLine;
  private readonly c: Colors;
  /** last rendered lines (tool names, statuses, notices) */
  readonly recent: string[] = [];
  /** final assistant text of the current turn (headless text mode) */
  turnText = "";

  constructor(private readonly opts: RendererOptions) {
    this.status = new StatusLine((t) => opts.err(t));
    this.c = opts.colors === false ? createColors(false) : pc;
  }

  private line(text: string, plain = text): void {
    this.status.stop();
    this.endStream();
    this.opts.out(`${text}\n`);
    this.remember(plain);
  }

  private remember(text: string): void {
    this.recent.push(text);
    if (this.recent.length > 30) this.recent.shift();
  }

  private endStream(): void {
    if (this.streaming) {
      this.opts.out("\n");
      this.streaming = false;
    }
  }

  notice(text: string): void {
    if (this.opts.jsonl) {
      this.opts.err(`${text}\n`);
      this.remember(text);
      return;
    }
    if (text.startsWith("WARNING:")) this.line(this.c.yellow(text), text);
    else if (text.startsWith("NOTICE:")) this.line(this.c.dim(`  ${text.slice("NOTICE:".length).trim()}`), text);
    else if (text.startsWith("SUPERVISOR:")) this.line(this.c.magenta(text), text);
    else if (text.startsWith("ERROR:")) this.line(this.c.red(text), text);
    else this.line(text);
  }

  private severityPrefix(sev: ErrorSeverity | undefined, message: string): string {
    if (sev === "warning") return `WARNING: ${message}`;
    if (sev === "notice") return `NOTICE: ${message}`;
    return message.startsWith("WARNING:") || message.startsWith("NOTICE:") || message.startsWith("ERROR:") ? message : `ERROR: ${message}`;
  }

  onEvent(e: AgentEvent): void {
    if (this.opts.jsonl) {
      this.opts.out(`${toJsonl(e)}\n`);
      this.trackText(e);
      return;
    }
    switch (e.type) {
      case "turn_started":
        this.turnText = "";
        if (this.opts.statusLine !== false) this.status.start();
        return;
      case "text_delta":
        this.status.stop();
        this.turnText += e.text;
        this.opts.out(e.text);
        this.streaming = true;
        return;
      case "thinking_delta":
        if (this.opts.showThinking) {
          this.status.stop();
          this.opts.out(this.c.dim(e.text));
          this.streaming = true;
        }
        return;
      case "tool_call_requested":
        this.line(`  [tool] ${e.tool} '${summarizeArgs(e.args)}'...`);
        return;
      case "tool_call_finished":
        if (e.status === "ok") this.line(`    OK. ${e.result_chars} chars.`);
        else if (e.status === "blocked") this.line(this.c.magenta(`    SUPERVISOR: ${e.result}`), `SUPERVISOR: ${e.result}`);
        else if (e.status === "cancelled") this.line(this.c.yellow("    cancelled"), "cancelled");
        else if (e.status === "timed_out") this.line(this.c.yellow(`    timed out: ${e.result.slice(0, 300)}`), `timed out: ${e.result.slice(0, 300)}`);
        else if (e.status === "unknown") this.line(this.c.yellow(`    unknown: ${e.result.slice(0, 300)}`), `unknown: ${e.result.slice(0, 300)}`);
        else this.line(this.c.red(`    ERROR: ${e.result.slice(0, 300)}`), `ERROR: ${e.result.slice(0, 300)}`);
        if (e.injected_note !== undefined && this.opts.showThinking) this.line(this.c.dim("    (supervisor note appended to the tool result)"));
        return;
      case "turn_finished":
        if (e.role === "generating") {
          this.status.stop();
          this.endStream();
          if (this.opts.ledger !== undefined) this.line(this.c.dim(`  ${this.opts.ledger.turnLine(e)}`), this.opts.ledger.turnLine(e));
        } else if (this.opts.showThinking) this.line(this.c.dim(`  (${e.role} call: in=${e.uncached_input + e.cache_read + e.cache_write} out=${e.output})`));
        return;
      case "error":
        this.notice(this.severityPrefix(e.severity, e.message));
        return;
      case "supervisor_intervention":
        if (e.kind === "governance_note") {
          if (this.opts.showThinking) this.line(this.c.dim(`  SUPERVISOR note: ${e.text}`), `SUPERVISOR note: ${e.text}`);
          return;
        }
        this.notice(`SUPERVISOR: ${e.kind === "guard_block" ? e.text : `${e.kind.replace("_", " ")} - ${e.text}`}`);
        return;
      case "memory_injected":
        if (this.opts.showThinking) this.line(this.c.dim(`  memories: ${e.memory_ids.length} injected`), `memories: ${e.memory_ids.length} injected`);
        return;
      case "executor_resumed":
        this.notice(`NOTICE: executor resumed (${e.reason})`);
        return;
      case "effect_pending":
        this.line(this.c.dim(`  pending: ${e.tool} - ${e.reason}`), `pending: ${e.tool} - ${e.reason}`);
        return;
      case "effect_resolved":
        this.line(this.c.dim(`  resolved: ${e.decision}`), `resolved: ${e.decision}`);
        return;
      case "checkpoint_created":
        this.notice(`NOTICE: context compacted (${e.truncated_messages} messages summarized, ${e.kept_messages} kept)`);
        return;
      case "user_message":
      case "session_started":
      case "prompt_step":
        return;
      default:
        return;
    }
  }

  private trackText(e: AgentEvent): void {
    if (e.type === "turn_started") this.turnText = "";
    else if (e.type === "text_delta") this.turnText += e.text;
  }

  /** Called at exit so a streamed line ends with a newline and the status line is cleared. */
  finish(): void {
    this.status.stop();
    this.endStream();
  }
}
