// Hand-rolled argv parser for the fixed flag set of HERAV1CLI-SP01 section 4 (HERAV1AGNT-IP01 IS-07).
// No dependency: the set is closed and small.

import { ConfigError } from "./errors.ts";
import { CHILD_ROLES, type ChildRole } from "./models.ts";

export interface ParsedArgs {
  version: boolean;
  help: boolean;
  role: ChildRole | undefined;
  epoch: number | undefined;
  debugViewer: boolean;
  acp: boolean;
  prompt: string | undefined;
  promptFile: string | undefined;
  outputFormat: "text" | "jsonl";
  resume: string | true | undefined;
  config: string | undefined;
  appDir: string | undefined;
  showThinking: boolean;
  debug: boolean;
  debugConsole: boolean;
  logDir: string | undefined;
  /** viewer only: loopback address of the Communicator's debug listener */
  connect: string | undefined;
  approveAll: boolean;
  positionals: string[];
}

const VALUE_FLAGS = new Set(["--role", "--epoch", "-p", "--prompt-file", "--output-format", "--config", "--app-dir", "--log-dir", "--connect"]);
const BOOL_FLAGS = new Set(["--version", "--help", "-h", "--debug-viewer", "--acp", "--show-thinking", "--debug", "--debug-console", "--approve-all"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    version: false,
    help: false,
    role: undefined,
    epoch: undefined,
    debugViewer: false,
    acp: false,
    prompt: undefined,
    promptFile: undefined,
    outputFormat: "text",
    resume: undefined,
    config: undefined,
    appDir: undefined,
    showThinking: false,
    debug: false,
    debugConsole: false,
    logDir: undefined,
    connect: undefined,
    approveAll: false,
    positionals: [],
  };
  const help = "Run 'hera --help' for the flag list.";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // `hera selftest ...`: the subcommand owns everything after it (its own flags: --menu, --provider, --model, --budget, --timeout)
    if (arg === "selftest" && out.positionals.length === 0) {
      out.positionals.push(...argv.slice(i));
      break;
    }
    if (arg === "--resume") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out.resume = next;
        i++;
      } else {
        out.resume = true;
      }
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith("--") && arg !== "-p")) {
        throw new ConfigError(`option '${arg}' requires a value.`, help);
      }
      i++;
      switch (arg) {
        case "--role":
          if (!(CHILD_ROLES as readonly string[]).includes(value)) {
            throw new ConfigError(`unknown role '${value}'. Valid roles: ${CHILD_ROLES.join(", ")}.`, "This flag is set by Hera itself when it spawns its child processes.");
          }
          out.role = value as ChildRole;
          break;
        case "--epoch": {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0) throw new ConfigError(`option '--epoch' expects a non-negative integer, got '${value}'.`, help);
          out.epoch = n;
          break;
        }
        case "-p":
          out.prompt = value;
          break;
        case "--prompt-file":
          out.promptFile = value;
          break;
        case "--output-format":
          if (value !== "text" && value !== "jsonl") throw new ConfigError(`option '--output-format' expects 'text' or 'jsonl', got '${value}'.`, help);
          out.outputFormat = value;
          break;
        case "--config":
          out.config = value;
          break;
        case "--app-dir":
          out.appDir = value;
          break;
        case "--log-dir":
          out.logDir = value;
          break;
        case "--connect":
          out.connect = value;
          break;
      }
      continue;
    }
    if (BOOL_FLAGS.has(arg)) {
      switch (arg) {
        case "--version":
          out.version = true;
          break;
        case "--help":
        case "-h":
          out.help = true;
          break;
        case "--debug-viewer":
          out.debugViewer = true;
          break;
        case "--acp":
          out.acp = true;
          break;
        case "--show-thinking":
          out.showThinking = true;
          break;
        case "--debug":
          out.debug = true;
          break;
        case "--debug-console":
          out.debugConsole = true;
          break;
        case "--approve-all":
          out.approveAll = true;
          break;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      throw new ConfigError(`unknown option '${arg}'.`, help);
    }
    out.positionals.push(arg);
  }
  const exclusive = [out.prompt !== undefined, out.promptFile !== undefined, out.acp, out.resume !== undefined].filter(Boolean).length;
  if (out.promptFile !== undefined && exclusive > 1) {
    throw new ConfigError("option '--prompt-file' cannot be combined with '-p', '--acp', or '--resume'.", help);
  }
  return out;
}

export const HELP_TEXT = `Usage: hera [options] | hera selftest [args]

Start:      hera | --app-dir <path> | --resume [session-file] | --config <path> | --show-thinking | --version
Debug:      --debug | --debug-console | --log-dir <path>
Headless:   -p "<prompt>" | --output-format text|jsonl | --approve-all
Queue:      --prompt-file <path>
ACP:        --acp
Selftest:   hera selftest [--menu | codes | offline | live | all] [--provider <id>] [--model <id>] [--budget <usd>]
`;
