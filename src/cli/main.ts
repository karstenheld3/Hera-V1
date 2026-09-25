// CLI entry (HERAV1CLI-SP01; HERAV1CLI-IP01 IS-08): flag exclusivity, startup, FrontendHooks, then the console or the
// headless driver over the Communicator core. Exit codes come from events; notices go to stderr in jsonl mode.

import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { Communicator, type FrontendHooks } from "../communicator/core.ts";
import { dlog } from "../debug/debuglog.ts";
import { setupDebug } from "../debug/setup.ts";
import { VERSION } from "../version.ts";
import { rolesSummary } from "../config/load.ts";
import { ConfigError, HeraError } from "../errors.ts";
import type { AgentEvent } from "../events.ts";
import type { PayloadOf } from "../process/envelope.ts";
import { projectSession } from "../session/projection.ts";
import { dispatchBuiltin, type BuiltinContext } from "./builtins.ts";
import { Console } from "./console.ts";
import { CostLedger } from "./cost.ts";
import { answerHeadless, deriveExitCode, runHeadless, type ExitCode } from "./headless.ts";
import { parsePromptQueueFile } from "./prompt_queue.ts";
import { Renderer } from "./render.ts";
import { startup } from "./startup.ts";

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  isTty: boolean;
  lines?: AsyncIterable<string>;
  env?: Record<string, string | undefined>;
  cwd?: string;
  entryMain?: string;
  /** injected for tests */
  onSigint?: (handler: () => void) => void;
}

const defaultIo: CliIo = { out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t), isTty: process.stdin.isTTY === true, onSigint: (h) => process.on("SIGINT", h) };

export function validateFlags(args: ParsedArgs): void {
  const modes = [args.prompt !== undefined ? "-p" : undefined, args.promptFile !== undefined ? "--prompt-file" : undefined, args.resume !== undefined ? "--resume" : undefined, args.acp ? "--acp" : undefined].filter((m): m is string => m !== undefined);
  if (modes.length > 1) throw new ConfigError(`the flags ${modes.join(" and ")} are mutually exclusive.`, "Pass one of them.");
}

export async function cliMain(args: ParsedArgs, io: CliIo = defaultIo): Promise<number> {
  const env = io.env ?? process.env;
  const jsonl = args.outputFormat === "jsonl";
  const headless = args.prompt !== undefined || args.promptFile !== undefined;
  const events: AgentEvent[] = [];
  let started;
  let prompts: string[] = [];
  try {
    validateFlags(args);
    if (args.promptFile !== undefined) {
      let text: string;
      try {
        text = readFileSync(args.promptFile, "utf8");
      } catch (error) {
        throw new ConfigError(`cannot read prompt file '${args.promptFile}': ${error instanceof Error ? error.message : String(error)}`, "Check the path.");
      }
      prompts = parsePromptQueueFile(text);
    } else if (args.prompt !== undefined) prompts = [args.prompt];
    started = startup(args, env, io.cwd ?? process.cwd());
  } catch (error) {
    if (error instanceof HeraError) {
      io.err(`ERROR: ${error.message}\n`);
      return deriveExitCode([], error);
    }
    throw error;
  }
  const noticeOut = jsonl ? io.err : io.out;
  // debug sinks open before the children spawn so their hello lines are the first visible ones (FR-01)
  const debug = setupDebug({ debugConsole: args.debugConsole, logDir: args.logDir, notice: (l) => io.err(`${l}\n`), env });
  if (debug.logPath !== undefined) noticeOut(`Debug log: '${debug.logPath}'.\n`);
  dlog("app", "startup", { mode: headless ? "headless" : "console", version: VERSION, standalone: Bun.isStandaloneExecutable });
  dlog("app", "roles", { roles: rolesSummary(started.config) });
  for (const line of started.lines) noticeOut(`${line}\n`);
  const ledger = CostLedger.fromConfig(started.config);
  const renderer = new Renderer({ showThinking: args.showThinking, jsonl, out: io.out, err: io.err, ledger, statusLine: io.isTty && !headless, colors: io.isTty });
  let turnWaiter: ((outcome: "finished" | "abandoned") => void) | undefined;
  const settleTurn = (outcome: "finished" | "abandoned"): void => {
    const w = turnWaiter;
    turnWaiter = undefined;
    w?.(outcome);
  };
  let comm: Communicator | undefined;
  let consoleUi: Console | undefined;
  const hooks: FrontendHooks = {
    handlesPending: true,
    onEvent: (e) => {
      events.push(e);
      ledger.onEvent(e);
      renderer.onEvent(e);
      if (e.type === "error" && e.proc === "exec" && e.category === "provider") settleTurn("abandoned");
      if (e.type === "error" && e.proc === "comm" && /^turn ended/.test(e.message)) settleTurn("abandoned");
    },
    onAskUser: (req: PayloadOf<"ask_user">) => {
      if (comm === undefined) return;
      if (headless || consoleUi === undefined) answerHeadless(comm, req, started.config.config.auto_continue, args.approveAll);
      else consoleUi.askUser(req);
    },
    onNotice: (line) => renderer.notice(line),
    onTurnEnd: () => {
      settleTurn("finished");
      consoleUi?.onTurnEnd();
    },
  };
  const t0 = performance.now();
  try {
    comm = new Communicator(hooks, { workspace: started.workspace, config: started.config, resumePath: started.resumePath, env, entryMain: io.entryMain, debugLines: debug.childEnv });
  } catch (error) {
    io.err(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (started.resumePath !== undefined) {
    const projectStarted = performance.now();
    const projection = projectSession(started.resumePath);
    dlog("app", "session", { file: comm.store.path.replace(/^.*[\\/]/, ""), resumed: true, dur_ms: Math.round(performance.now() - projectStarted) });
    ledger.rebuild(projection);
    for (const w of projection.warnings) renderer.notice(w);
    noticeOut(`Resumed session '${comm.sessionId}': ${projection.completedTurns} turn${projection.completedTurns === 1 ? "" : "s"}, ${projection.messages.length} messages.\n`);
  }
  try {
    await comm.start();
  } catch (error) {
    io.err(`ERROR: startup failed -> ${error instanceof Error ? error.message : String(error)}\n`);
    await comm.shutdown("startup failure");
    return 4;
  }
  if (started.resumePath === undefined) dlog("app", "session", { file: comm.store.path.replace(/^.*[\\/]/, ""), resumed: false });
  const status = comm.status();
  const UNKNOWN = "[UNKNOWN]";
  noticeOut(`Processes: executor pid='${status.children[0]?.pid ?? UNKNOWN}', supervisor pid='${status.children[1]?.pid ?? UNKNOWN}'. Ready in ${((performance.now() - t0) / 1000).toFixed(1)} secs.\n`);
  const builtinCtx: BuiltinContext = { comm, config: started.config, ledger, workflows: started.workflows, recentLines: () => renderer.recent, queuedPrompt: () => consoleUi?.queue.peek(), env };
  const waitTurnEnd = (): Promise<"finished" | "abandoned"> =>
    new Promise((resolve) => {
      turnWaiter = resolve;
    });
  let code: ExitCode = 0;
  if (headless) {
    code = await runHeadless({ comm, renderer, builtinCtx, prompts, out: io.out, err: io.err, events, autoContinue: started.config.config.auto_continue, approveAll: args.approveAll, waitTurnEnd, jsonl });
  } else {
    let shutdownRequested: (() => void) | undefined;
    const shutdownPromise = new Promise<void>((r) => {
      shutdownRequested = r;
    });
    consoleUi = new Console({
      comm,
      builtinCtx,
      out: io.out,
      notice: (t) => {
        if (t === "NOTICE: queued as next prompt") dlog("app", "input_queued", {});
        else if (t === "NOTICE: replaced queued prompt") dlog("app", "input_replaced", {});
        renderer.notice(t);
      },
      isTty: io.isTty,
      lines: io.lines,
      turnActive: () => comm?.status().turn !== "idle",
      autoContinue: started.config.config.auto_continue,
      onShutdown: () => shutdownRequested?.(),
    });
    const ui = consoleUi;
    io.onSigint?.(() => {
      if (comm?.status().turn !== "idle") {
        io.err("Cancelling...\n");
        comm?.cancel("user");
      } else {
        ui.stop();
        shutdownRequested?.();
      }
    });
    void ui.run();
    await shutdownPromise;
    code = 0;
  }
  renderer.finish();
  const result = await comm.shutdown("exit");
  if (result.killed.length > 0) io.err(`WARNING: killed ${result.killed.join(", ")} during shutdown.\n`);
  dlog("app", "exit_code", { code, source: headless ? "headless turn events" : "console exit" });
  await debug.close();
  return code;
}

export { dispatchBuiltin };
