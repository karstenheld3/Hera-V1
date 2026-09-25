// Headless driver and exit codes (HERAV1CLI-SP01 FR-03, FR-05; HERAV1CLI-IP01 IS-07). Exit codes derive from events only.

import type { Communicator } from "../communicator/core.ts";
import { ConfigError, HeraError } from "../errors.ts";
import { nowTs, type AgentEvent } from "../events.ts";
import type { PayloadOf } from "../process/envelope.ts";
import { dispatchBuiltin, type BuiltinContext } from "./builtins.ts";
import { promptStepEvent } from "./prompt_queue.ts";
import type { Renderer } from "./render.ts";

export type ExitCode = 0 | 2 | 3 | 4;

export const NON_INTERACTIVE_ANSWER = "no answer (non-interactive session)";

/** Exit code from the events of the turns that ran (FR-03): 2 config, 3 provider failure, 4 stopped without completion, else 0. */
export function deriveExitCode(events: readonly AgentEvent[], startupError?: HeraError | Error, extra: { restartBudgetExhausted?: boolean; ackTimeout?: boolean; turnsExpected?: number } = {}): ExitCode {
  if (startupError !== undefined) return startupError instanceof ConfigError ? 2 : 4;
  if (extra.restartBudgetExhausted === true || extra.ackTimeout === true) return 4;
  const turns = events.filter((e) => e.type === "turn_finished" && e.role === "generating") as Array<Extract<AgentEvent, { type: "turn_finished" }>>;
  const providerErrors = events.filter((e) => e.type === "error" && e.category === "provider");
  const expected = extra.turnsExpected ?? 1;
  if (turns.length < expected) return providerErrors.length > 0 ? 3 : 4;
  if (turns.some((t) => t.stop_reason === "cancelled")) return 4;
  if (events.some((e) => e.type === "error" && e.category === "limit")) return 4;
  return 0;
}

export interface HeadlessOptions {
  comm: Communicator;
  renderer: Renderer;
  builtinCtx: BuiltinContext;
  prompts: string[];
  /** headless output: final assistant text per turn (text mode) */
  out: (text: string) => void;
  err: (text: string) => void;
  events: AgentEvent[];
  autoContinue: boolean;
  approveAll: boolean;
  /** resolves when the current turn ended (set by the hooks) */
  waitTurnEnd: () => Promise<"finished" | "abandoned">;
  jsonl: boolean;
}

/** Non-interactive answers (FR-03): questions get the fallback text, continue gets proceed=false unless auto_continue, pending denies with NOTICE (U08). */
export function answerHeadless(comm: Communicator, req: PayloadOf<"ask_user">, autoContinue: boolean, approveAll = false): void {
  if (req.kind === "pending") {
    const effectId = req.effect_id ?? "";
    if (approveAll) {
      comm.resolvePending(effectId, "allow");
    } else {
      comm.resolvePending(effectId, "deny");
      const firstToken = (req.summary ?? req.tool ?? "").split(/\s+/)[0] ?? "";
      comm.appendOwnEvent({ ts: nowTs(), proc: "comm", type: "error", severity: "notice", message: `NOTICE: run_command '${firstToken}' denied - headless mode has no approver; use --approve-all or SafeToAutoRun` } as AgentEvent);
    }
    return;
  }
  if (req.kind === "continue") comm.continueDecision(autoContinue);
  else comm.answer({ request_id: req.request_id, text: NON_INTERACTIVE_ANSWER });
}

/** Runs the prompts in order as turns of one session; stops at the first failed turn. Returns the exit code. */
export async function runHeadless(opts: HeadlessOptions): Promise<ExitCode> {
  const total = opts.prompts.length;
  let ran = 0;
  let abandoned = false;
  for (const [i, prompt] of opts.prompts.entries()) {
    const builtin = dispatchBuiltin(prompt, opts.builtinCtx);
    if (builtin.kind === "lines" || builtin.kind === "async") {
      const lines = builtin.kind === "lines" ? builtin.lines : await builtin.done;
      for (const l of lines) opts.out(`${l}\n`);
      continue;
    }
    if (builtin.kind === "shutdown") break;
    if (total > 1) {
      const step = promptStepEvent(i + 1, total, prompt);
      opts.comm.appendOwnEvent(step);
    }
    opts.renderer.turnText = "";
    opts.comm.submitPrompt(prompt);
    ran++;
    const outcome = await opts.waitTurnEnd();
    if (outcome === "abandoned") {
      abandoned = true;
      break;
    }
    if (!opts.jsonl && opts.renderer.turnText.length > 0) opts.out(`${opts.renderer.turnText.endsWith("\n") ? opts.renderer.turnText : `${opts.renderer.turnText}\n`}`);
    const lastTurn = [...opts.events].reverse().find((e) => e.type === "turn_finished" && e.role === "generating") as Extract<AgentEvent, { type: "turn_finished" }> | undefined;
    if (lastTurn === undefined || lastTurn.stop_reason === "cancelled" || opts.events.some((e) => e.type === "error" && e.category === "limit")) {
      abandoned = true;
      break;
    }
  }
  return deriveExitCode(opts.events, undefined, { turnsExpected: ran });
}
