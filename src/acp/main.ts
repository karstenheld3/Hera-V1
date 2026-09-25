// ACP entry (HERAV1ACP-SP01 FR-01; HERAV1ACP-IP01 IS-06): `hera --acp`. The children spawn before the first stdin line
// (initialize never waits on a spawn); the session opens at session/new or session/load. stdout carries only JSON-RPC
// lines written by the connection; every diagnostic goes to stderr.

import type { ParsedArgs } from "../args.ts";
import { CostLedger } from "../cli/cost.ts";
import { startup, RISK_STATEMENT } from "../cli/startup.ts";
import { Communicator, type FrontendHooks } from "../communicator/core.ts";
import { rolesSummary } from "../config/load.ts";
import { dlog } from "../debug/debuglog.ts";
import { setupDebug } from "../debug/setup.ts";
import { ConfigError, HeraError } from "../errors.ts";
import { VERSION } from "../version.ts";
import { AcpConnection } from "./connection.ts";
import { AcpServer } from "./server.ts";

export interface AcpIo {
  /** protocol writer: one line per call, resolves when handed to the OS */
  write: (text: string) => Promise<void>;
  err: (text: string) => void;
  lines: AsyncIterable<string>;
  env?: Record<string, string | undefined>;
  cwd?: string;
  entryMain?: string;
}

const stamp = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

export function defaultAcpIo(): AcpIo {
  return {
    write: (text) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(text, (error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    err: (text) => void process.stderr.write(text),
    lines: stdinLines(),
  };
}

async function* stdinLines(): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const p of parts) yield p;
  }
  pending += decoder.decode();
  if (pending.length > 0) yield pending;
}

export async function acpMain(args: ParsedArgs, io: AcpIo = defaultAcpIo()): Promise<number> {
  const env = io.env ?? process.env;
  const log = (line: string): void => io.err(`${stamp()} ${line}\n`);
  if (args.prompt !== undefined || args.promptFile !== undefined || args.resume !== undefined) {
    io.err("ERROR: --acp is mutually exclusive with -p, --prompt-file, and --resume.\n");
    return 2;
  }
  let started;
  try {
    started = startup(args, env, io.cwd ?? process.cwd());
  } catch (error) {
    if (error instanceof HeraError) {
      io.err(`ERROR: ${error.message}\n`);
      return error instanceof ConfigError ? 2 : 4;
    }
    throw error;
  }
  const debug = setupDebug({ debugConsole: args.debugConsole, logDir: args.logDir, notice: (l) => io.err(`${l}\n`), env });
  dlog("app", "startup", { mode: "acp", version: VERSION, standalone: Bun.isStandaloneExecutable });
  dlog("app", "roles", { roles: rolesSummary(started.config) });
  for (const line of started.lines) log(line);
  log(RISK_STATEMENT);
  const ledger = CostLedger.fromConfig(started.config);
  const connection = new AcpConnection({ write: io.write, stderr: (l) => log(l) });
  let server: AcpServer | undefined;
  const hooks: FrontendHooks = {
    onEvent: (e) => {
      ledger.onEvent(e);
      server?.onEvent(e);
    },
    onAskUser: (req) => server?.onAskUser(req),
    onNotice: (line) => log(line),
    onTurnEnd: () => server?.onTurnEnd(),
    handlesPending: true,
  };
  const comm = new Communicator(hooks, { workspace: started.workspace, config: started.config, env, entryMain: io.entryMain, debugLines: debug.childEnv, deferSession: true });
  server = new AcpServer({ connection, comm, config: started.config, ledger, workflows: started.workflows, stderr: (l) => log(l) });
  try {
    await comm.start();
  } catch (error) {
    io.err(`ERROR: startup failed -> ${error instanceof Error ? error.message : String(error)}\n`);
    await comm.shutdown("startup failure");
    return 4;
  }
  const status = comm.status();
  log(`ACP server ready on stdio (executor pid='${status.children[0]?.pid ?? "[UNKNOWN]"}', supervisor pid='${status.children[1]?.pid ?? "[UNKNOWN]"}').`);
  await connection.run(io.lines);
  server.onEof();
  await connection.writer.flush();
  const result = await comm.shutdown("stdin EOF");
  if (result.killed.length > 0) log(`WARNING: killed ${result.killed.join(", ")} during shutdown.`);
  dlog("app", "exit_code", { code: 0, source: "stdin EOF" });
  await debug.close();
  return 0;
}
