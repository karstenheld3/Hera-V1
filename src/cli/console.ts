// Interactive console with the one-slot input queue (HERAV1CLI-SP01 FR-01; HERAV1CLI-IP01 IS-05). Free text never
// waits for the Executor: it is sent as a prompt or queued; built-ins answer at once; Ctrl+C cancels or exits.
// @clack/prompts widgets serve a terminal; a non-terminal stdin is read as plain lines (pipe-driven sessions).

import { confirm, isCancel, multiselect, select, text } from "@clack/prompts";
import type { Communicator } from "../communicator/core.ts";
import type { PayloadOf } from "../process/envelope.ts";
import { dispatchBuiltin, type BuiltinContext } from "./builtins.ts";
import { digest } from "./prompt_queue.ts";

export class InputQueue {
  private slot: string | undefined;

  set(textValue: string): "queued" | "replaced" {
    const outcome = this.slot === undefined ? "queued" : "replaced";
    this.slot = textValue;
    return outcome;
  }

  take(): string | undefined {
    const value = this.slot;
    this.slot = undefined;
    return value;
  }

  peek(): string | undefined {
    return this.slot;
  }

  peekDigest(): string | null {
    return this.slot === undefined ? null : digest(this.slot);
  }
}

export interface ConsoleOptions {
  comm: Communicator;
  builtinCtx: BuiltinContext;
  out: (text: string) => void;
  notice: (text: string) => void;
  isTty: boolean;
  /** injected line source for tests and pipes; undefined → process.stdin */
  lines?: AsyncIterable<string>;
  turnActive: () => boolean;
  autoContinue: boolean;
  onShutdown: () => void;
}

export class Console {
  readonly queue = new InputQueue();
  private stopped = false;
  private pendingAsk: PayloadOf<"ask_user"> | undefined;

  constructor(private readonly opts: ConsoleOptions) {}

  /** Handles one input line; never awaits a child (built-ins answer locally, prompts are fire-and-forget). */
  handleLine(line: string): void {
    const trimmed = line.trim();
    if (this.pendingAsk !== undefined) {
      this.answerPlain(trimmed);
      return;
    }
    if (trimmed.length === 0) return;
    const builtin = dispatchBuiltin(trimmed, this.opts.builtinCtx);
    if (builtin.kind === "lines") {
      for (const l of builtin.lines) this.opts.out(`${l}\n`);
      return;
    }
    if (builtin.kind === "async") {
      void builtin.done.then((lines) => {
        for (const l of lines) this.opts.out(`${l}\n`);
      });
      return;
    }
    if (builtin.kind === "shutdown") {
      this.stop();
      this.opts.onShutdown();
      return;
    }
    if (this.opts.turnActive()) {
      const outcome = this.queue.set(trimmed);
      this.opts.notice(outcome === "queued" ? "NOTICE: queued as next prompt" : "NOTICE: replaced queued prompt");
      return;
    }
    this.opts.comm.submitPrompt(trimmed);
  }

  /** Called by the frontend hooks on turn_finished: the queued line becomes the next prompt. */
  onTurnEnd(): void {
    const next = this.queue.take();
    if (next !== undefined && !this.stopped) {
      this.opts.notice("NOTICE: sending queued prompt");
      this.opts.comm.submitPrompt(next);
    }
  }

  /** ask_user in a terminal renders a widget; on a pipe the next input line answers (or the fallback on EOF). */
  askUser(req: PayloadOf<"ask_user">): void {
    if (req.kind === "pending") {
      if (this.opts.isTty) {
        void this.askPendingWidget(req);
        return;
      }
      this.pendingAsk = req;
      this.opts.out(`Approve run_command: ${req.summary ?? req.tool}? [y/n]\n`);
      return;
    }
    if (this.opts.isTty) {
      void this.askWithWidgets(req);
      return;
    }
    this.pendingAsk = req;
    if (req.kind === "continue") this.opts.out(`Tool call limit reached. Continue? [y/n]\n`);
    else {
      this.opts.out(`${req.question ?? "Question"}\n`);
      (req.options ?? []).forEach((o, i) => this.opts.out(`  ${i + 1}) ${o.label}${o.description !== undefined ? ` - ${o.description}` : ""}\n`));
      this.opts.out(`Answer with a number${req.allow_multiple === true ? "s (comma separated)" : ""} or free text:\n`);
    }
  }

  /** U08: TTY approval widget for pending gate decisions. */
  private async askPendingWidget(req: PayloadOf<"ask_user">): Promise<void> {
    const effectId = req.effect_id ?? "";
    const summary = req.summary ?? req.tool;
    const reason = req.reason ?? "";
    const message = `${summary}${reason.length > 0 ? `\n${reason}` : ""}\nApprove?`;
    const proceed = await confirm({ message });
    const decision = isCancel(proceed) ? "deny" : proceed === true ? "allow" : "deny";
    this.opts.comm.resolvePending(effectId, decision as "allow" | "deny");
  }

  private answerPlain(line: string): void {
    const req = this.pendingAsk as PayloadOf<"ask_user">;
    this.pendingAsk = undefined;
    if (req.kind === "pending") {
      const effectId = req.effect_id ?? "";
      const decision = /^y(es)?$/i.test(line) ? "allow" : "deny";
      this.opts.comm.resolvePending(effectId, decision);
      return;
    }
    if (req.kind === "continue") {
      this.opts.comm.continueDecision(/^y(es)?$/i.test(line));
      return;
    }
    const options = req.options ?? [];
    const numbers = line.split(/[,\s]+/).map((p) => Number(p)).filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length);
    if (numbers.length > 0) this.opts.comm.answer({ request_id: req.request_id, selected: numbers.map((n) => options[n - 1]?.label ?? "") });
    else this.opts.comm.answer({ request_id: req.request_id, text: line });
  }

  private async askWithWidgets(req: PayloadOf<"ask_user">): Promise<void> {
    if (req.kind === "continue") {
      const proceed = await confirm({ message: "Tool call limit reached. Continue?" });
      this.opts.comm.continueDecision(!isCancel(proceed) && proceed === true);
      return;
    }
    const options = (req.options ?? []).map((o) => ({ value: o.label, label: o.label, hint: o.description }));
    options.push({ value: "__free__", label: "Other (type an answer)", hint: undefined });
    let selected: string[] = [];
    if (req.allow_multiple === true) {
      const picked = await multiselect({ message: req.question ?? "Choose", options });
      if (!isCancel(picked)) selected = picked as string[];
    } else {
      const picked = await select({ message: req.question ?? "Choose", options });
      if (!isCancel(picked)) selected = [picked as string];
    }
    if (selected.includes("__free__")) {
      const free = await text({ message: "Your answer" });
      this.opts.comm.answer({ request_id: req.request_id, text: isCancel(free) ? "" : String(free) });
      return;
    }
    this.opts.comm.answer({ request_id: req.request_id, selected });
  }

  /** Reads input until EOF (shutdown) or stop(). */
  async run(): Promise<void> {
    const source = this.opts.lines ?? stdinLines();
    for await (const line of source) {
      if (this.stopped) break;
      this.handleLine(line);
    }
    if (!this.stopped) {
      this.stop();
      this.opts.onShutdown();
    }
  }

  stop(): void {
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}

/** Plain line reader over stdin (UTF-8), used for pipes and as the terminal fallback. */
export async function* stdinLines(): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const p of parts) yield p;
  }
  pending += decoder.decode();
  if (pending.length > 0) yield pending;
}
