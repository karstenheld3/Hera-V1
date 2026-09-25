// Hera V1 entrypoint (HERAV1AGNT-IP01 IS-07): one binary, dispatched by flags into the three process roles,
// the debug viewer, the selftest subcommand, or the Communicator. Explicit main() - no top-level await.

import { HELP_TEXT, parseArgs, type ParsedArgs } from "./args.ts";
import { HeraError } from "./errors.ts";
import { VERSION } from "./version.ts";

type RoleEntry = (args: ParsedArgs) => Promise<number>;

async function stubRole(args: ParsedArgs): Promise<number> {
  // Test hook (HERAV1PROC-TP01 section 3): under `bun run` a stub role module replaces the real role.
  const stubModule = process.env["HERA_STUB_ROLE_MODULE"];
  const behavior = process.env["HERA_STUB_ROLE_BEHAVIOR"];
  if (stubModule !== undefined && behavior !== undefined && !Bun.isStandaloneExecutable && args.role !== undefined) {
    const mod = (await import(stubModule)) as { stubMain(role: string, behavior: string, epoch: number | undefined): Promise<number> };
    return mod.stubMain(args.role, behavior, args.epoch);
  }
  return Promise.resolve(-1);
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof HeraError ? error.exitCode : 2;
  }
  // Spawn-cascade guard (HERAV1-FL-0002): a process started as the debug viewer may run nothing but the viewer.
  if (process.env["HERA_VIEWER_SPAWNED"] !== undefined && !args.debugViewer) {
    process.stderr.write("ERROR: HERA_VIEWER_SPAWNED is set but this is not a --debug-viewer invocation -> refusing to run (spawn recursion guard).\n");
    return 2;
  }
  if (args.version) {
    process.stdout.write(`hera ${VERSION}\n`);
    return 0;
  }
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  try {
    if (args.role !== undefined) {
      const stubbed = await stubRole(args);
      if (stubbed >= 0) return stubbed;
      const entry: RoleEntry = args.role === "executor" ? (await import("./executor/main.ts")).executorMain : (await import("./supervisor/main.ts")).supervisorMain;
      return await entry(args);
    }
    if (args.debugViewer) return await (await import("./debug/viewer.ts")).viewerMain(args);
    if (args.positionals[0] === "selftest") return await (await import("./selftest/runner.ts")).selftestMain(args);
    return await (await import("./communicator/main.ts")).communicatorEntry(args);
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof HeraError ? error.exitCode : 1;
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
