// Shell tools: run_command and command_status (HERAV1TOOL-SP01 FR-06; HERAV1TOOL-IP01 IS-05). Port of V1 shell_tools.py.
// Every spawned pid is registered with ctx.children (spec 05 DD-09); the Supervisor guard runs before this tool is
// reached, so nothing here judges the command. SafeToAutoRun is accepted by the schema and discarded.

import { existsSync, statSync } from "node:fs";
import { ToolError } from "../errors.ts";
import type { ToolContext, ToolResult } from "./registry.ts";
import { EffectDescriptor } from "../harness/descriptor.ts";
import { spawn as harnessSpawn } from "../harness/spawn.ts";

export const DEFAULT_BLOCKING_TIMEOUT_MS = 600_000;
export const MAX_STATUS_WAIT_SECONDS = 60;
export const TERMINATE_WAIT_MS = 3000;

export interface BackgroundProcess {
  commandId: string;
  commandLine: string;
  pid: number;
  proc: BunSubprocess;
  output: string[];
  done: boolean;
  exitCode: number | null;
  exited: Promise<void>;
}

/** The per-Executor command table; the Executor terminates everything through terminateAll() on cancel and shutdown. */
export class CommandTable {
  readonly processes = new Map<string, BackgroundProcess>();
  private counter = 0;

  nextId(): string {
    this.counter++;
    return `cmd_${crypto.randomUUID().slice(0, 8)}`;
  }

  get(id: string): BackgroundProcess | undefined {
    return this.processes.get(id);
  }

  ids(): string[] {
    return [...this.processes.keys()];
  }

  live(): BackgroundProcess[] {
    return [...this.processes.values()].filter((p) => !p.done);
  }

  /** Terminates every live child (best effort) and reports labels of terminated and surviving processes. */
  async terminateAll(): Promise<{ terminated: string[]; survivors: string[] }> {
    const terminated: string[] = [];
    const survivors: string[] = [];
    for (const p of this.live()) {
      const label = `${p.commandId} (${p.commandLine.slice(0, 60)})`;
      p.proc.kill();
      const result = await Promise.race([p.exited.then(() => "exited" as const), Bun.sleep(TERMINATE_WAIT_MS).then(() => "alive" as const)]);
      if (result === "exited") terminated.push(label);
      else {
        try {
          p.proc.kill("SIGKILL");
        } catch {
          /* gone */
        }
        survivors.push(label);
      }
    }
    return { terminated, survivors };
  }
}

const tables = new WeakMap<ToolContext, CommandTable>();

export function commandTableOf(ctx: ToolContext): CommandTable {
  let table = tables.get(ctx);
  if (table === undefined) {
    table = new CommandTable();
    tables.set(ctx, table);
  }
  return table;
}

/** Host shell per OS: PowerShell 7 on Windows, sh elsewhere (spec 05 FR-06). */
export function shellArgv(commandLine: string, platform: string = process.platform): string[] {
  if (platform === "win32") return ["pwsh", "-NoProfile", "-NonInteractive", "-Command", commandLine];
  return ["sh", "-c", commandLine];
}

async function drain(stream: ReadableStream<Uint8Array> | undefined, into: string[]): Promise<void> {
  if (stream === undefined) return;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let pending = "";
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    into.push(...parts);
  }
  pending += decoder.decode();
  if (pending.length > 0) into.push(pending);
}

let spawnCounter = 0;

async function startProcess(commandLine: string, cwd: string, ctx: ToolContext): Promise<BackgroundProcess> {
  const table = commandTableOf(ctx);
  let proc: BunSubprocess;
  try {
    const gate = ctx.gate;
    const descriptor = new EffectDescriptor({
      effect_id: `fx_spawn_${++spawnCounter}`,
      kind: "process.spawn",
      target: "shell",
      parameters: { command_line: commandLine, cwd },
    });
    let spawned: BunSubprocess | undefined;
    const result = await gate.egress(descriptor, async () => {
      spawned = harnessSpawn(shellArgv(commandLine, ctx.os?.platform), { kind: "tool", cwd, env: { PAGER: "cat" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { status: "ok" as const, text: "spawned" };
    });
    if (result.status === "blocked") throw new ToolError(`Cannot run command: ${result.text}`, "The gate blocked this command.");
    if (spawned === undefined) throw new ToolError("Cannot run command: gate returned no process", "Internal error.");
    proc = spawned;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found|No such file/i.test(message)) throw new ToolError("Cannot start 'pwsh' - PowerShell 7 is required on PATH.", "Install PowerShell 7 or add it to PATH.");
    throw new ToolError(`Cannot run command: ${message}`, "Check the command line and the working directory.");
  }
  const record: BackgroundProcess = { commandId: table.nextId(), commandLine, pid: proc.pid, proc, output: [], done: false, exitCode: null, exited: Promise.resolve() };
  ctx.children.register(proc.pid, `run_command: ${commandLine.slice(0, 120)}`);
  record.exited = Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>, record.output), drain(proc.stderr as ReadableStream<Uint8Array>, record.output), proc.exited]).then(([, , code]) => {
    record.done = true;
    record.exitCode = code;
    ctx.children.deregister(proc.pid);
  });
  table.processes.set(record.commandId, record);
  return record;
}

const outputText = (p: BackgroundProcess): string => p.output.join("\n");

async function waitFor(p: BackgroundProcess, ms: number): Promise<boolean> {
  if (p.done) return true;
  const result = await Promise.race([p.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  return result;
}

export async function runCommand(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const commandLine = String(args["CommandLine"]);
  if (commandLine.trim().length === 0) throw new ToolError("CommandLine is empty.", "Pass the command to run.");
  const cwd = typeof args["Cwd"] === "string" && args["Cwd"].length > 0 ? args["Cwd"] : ctx.workspace;
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ToolError(`Cwd '${cwd}' is not an existing directory.`, "Pass an existing directory as Cwd.");
  const record = await startProcess(commandLine, cwd, ctx);
  const onAbort = (): void => {
    record.proc.kill();
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (args["Blocking"] === true) {
      const finished = await waitFor(record, DEFAULT_BLOCKING_TIMEOUT_MS);
      if (!finished) return { status: "ok", text: `Command still running after ${DEFAULT_BLOCKING_TIMEOUT_MS / 1000} s - moved to background with ID ${record.commandId}. Check it with command_status.`, meta: { childPid: record.pid, commandId: record.commandId } };
      return { status: ctx.signal.aborted ? "cancelled" : "ok", text: `Exit code ${record.exitCode}\nOutput:\n${outputText(record)}`, meta: { childPid: record.pid, commandId: record.commandId } };
    }
    const waitMs = typeof args["WaitMsBeforeAsync"] === "number" ? Math.max(0, args["WaitMsBeforeAsync"]) : 0;
    const finished = await waitFor(record, waitMs);
    if (finished) return { status: "ok", text: `Command ${record.commandId} finished before the wait ended.\nExit code ${record.exitCode}\nOutput:\n${outputText(record)}`, meta: { childPid: record.pid, commandId: record.commandId } };
    const preview = outputText(record);
    const suffix = preview.length > 0 ? `\nOutput so far:\n${preview}` : "";
    return { status: "ok", text: `Command running in background with ID ${record.commandId}. Check it with command_status.${suffix}`, meta: { childPid: record.pid, commandId: record.commandId } };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

export async function commandStatus(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const table = commandTableOf(ctx);
  const id = String(args["CommandId"]);
  const record = table.get(id);
  if (record === undefined) throw new ToolError(`Unknown command ID '${id}'. Known background IDs: ${table.ids().join(", ") || "(none)"}`, "Use the CommandId returned by run_command.");
  const requested = typeof args["WaitDurationSeconds"] === "number" ? Math.max(0, args["WaitDurationSeconds"]) : 0;
  const waitSeconds = Math.min(requested, MAX_STATUS_WAIT_SECONDS);
  if (waitSeconds > 0) await waitFor(record, waitSeconds * 1000);
  const status = record.done ? "done" : "running";
  let output = outputText(record);
  const maxChars = Number(args["OutputCharacterCount"]);
  if (output.length > maxChars) output = output.slice(-maxChars);
  const exitLine = record.done ? `\nExit code ${record.exitCode}` : "";
  const clamp = requested > MAX_STATUS_WAIT_SECONDS ? `\nNOTE: WaitDurationSeconds ${requested} clamped to ${MAX_STATUS_WAIT_SECONDS} s (tool contract maximum).` : "";
  return { status: "ok", text: `Status: ${status}${exitLine}${clamp}\nOutput:\n${output}`, meta: { childPid: record.pid, commandId: record.commandId } };
}
