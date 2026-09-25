// Communicator entry: the CLI frontend over the Communicator core (HERAV1PROC-IP01 IS-08 core in core.ts;
// HERAV1CLI-IP01 IS-08 wiring in cli/main.ts). The ACP frontend attaches here in a later prompt.

import type { ParsedArgs } from "../args.ts";
import { cliMain } from "../cli/main.ts";

export async function communicatorEntry(args: ParsedArgs): Promise<number> {
  if (args.acp) return (await import("../acp/main.ts")).acpMain(args);
  return cliMain(args);
}