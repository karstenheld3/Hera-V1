// Black-box driver for the real entrypoint (HERAV1AGNT-TP01 section 8, HERAV1AGNT-IP01 IS-08).
// Runs the compiled binary when HERA_TEST_BINARY is set, else `bun run src/index.ts`.

import { existsSync } from "node:fs";
import { fromJsonl, readJsonlFile, type AgentEvent } from "../../src/events.ts";
import { heraCommand, waitFor } from "./procs.ts";

export interface HeraProcOptions {
  workspace: string;
  appDir?: string;
  configPath?: string;
  scriptPath?: string;
  env?: Record<string, string>;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ChildHandle {
  pid: number;
  send(line: string): void;
  endInput(): void;
  stdout(): string;
  stderr(): string;
  waitExit(timeoutMs: number): Promise<number | null>;
  kill(): void;
}

async function drain(stream: ReadableStream<Uint8Array> | number | undefined, sink: { text: string }): Promise<void> {
  if (stream === undefined || typeof stream === "number") return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sink.text += decoder.decode(value, { stream: true });
  }
}

export class HeraProc {
  constructor(private readonly opts: HeraProcOptions) {}

  private env(extra?: Record<string, string>): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, ...this.opts.env, ...extra };
    if (this.opts.appDir !== undefined) env["AGENT_APP_DIR"] = this.opts.appDir;
    if (this.opts.configPath !== undefined) env["AGENT_CONFIG"] = this.opts.configPath;
    if (this.opts.scriptPath !== undefined) env["HERA_SCRIPTED_ADAPTER"] = this.opts.scriptPath;
    return env;
  }

  /** Run once with the given arguments and collect stdout/stderr; kills the process at the timeout (harness liveness). */
  run(args: string[], o: { timeoutMs?: number; stdin?: string } = {}): Promise<RunResult> {
    return this.runWith([...heraCommand(), ...args], o);
  }

  /** Run with retry on immediate exit code 1 (module resolution can fail under parallel load). */
  async runWithRetry(args: string[], o: { timeoutMs?: number; stdin?: string; retries?: number } = {}): Promise<RunResult> {
    const retries = o.retries ?? 2;
    let result: RunResult = { code: 1, stdout: "", stderr: "", timedOut: false, durationMs: 0 };
    for (let attempt = 0; attempt <= retries; attempt++) {
      result = await this.run(args, o);
      // Only retry on code 1 with very short duration (module resolution failure under parallel load)
      if (result.code !== 1 || result.durationMs > 2000 || result.timedOut || attempt === retries) break;
      await Bun.sleep(500);
    }
    return result;
  }

  /** Same driver for an arbitrary command (used by the harness liveness test). */
  async runWith(cmd: string[], o: { timeoutMs?: number; stdin?: string } = {}): Promise<RunResult> {
    const started = performance.now();
    const proc = Bun.spawn(cmd, {
      cwd: this.opts.workspace,
      env: this.env(),
      stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = { text: "" };
    const err = { text: "" };
    const pumps = Promise.all([drain(proc.stdout, out), drain(proc.stderr, err)]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, o.timeoutMs ?? 15000);
    const code = await proc.exited;
    clearTimeout(timer);
    await pumps;
    return { code: timedOut ? null : code, stdout: out.text, stderr: err.text, timedOut, durationMs: performance.now() - started };
  }

  runHeadless(prompt: string, o: { outputFormat?: "text" | "jsonl"; timeoutMs?: number; extraArgs?: string[] } = {}): Promise<RunResult> {
    const args = ["-p", prompt, "--output-format", o.outputFormat ?? "jsonl", ...(o.extraArgs ?? [])];
    return this.run(args, { timeoutMs: o.timeoutMs });
  }

  /** Interactive run over piped stdin (never a pseudo-terminal). */
  startPiped(extraArgs: string[] = []): ChildHandle {
    const proc = Bun.spawn([...heraCommand(), ...extraArgs], {
      cwd: this.opts.workspace,
      env: this.env(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = { text: "" };
    const err = { text: "" };
    void drain(proc.stdout, out);
    void drain(proc.stderr, err);
    const stdin = proc.stdin as BunFileSink;
    return {
      pid: proc.pid,
      send(line: string) {
        stdin.write(line.endsWith("\n") ? line : `${line}\n`);
        void stdin.flush();
      },
      endInput() {
        void stdin.end();
      },
      stdout: () => out.text,
      stderr: () => err.text,
      async waitExit(timeoutMs: number) {
        const result = await Promise.race([proc.exited, Bun.sleep(timeoutMs).then(() => null)]);
        if (result === null) proc.kill();
        return result;
      },
      kill: () => proc.kill(),
    };
  }

  /** Parsed stdout JSONL of a headless jsonl run; non-JSON lines are ignored (they belong on stderr anyway). */
  events(result: RunResult): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        events.push(fromJsonl(line));
      } catch {
        /* not an event line */
      }
    }
    return events;
  }

  /** Waits until the session file at `path` contains an event matching `pred`. */
  async tailSession(path: string, pred: (e: AgentEvent) => boolean, timeoutMs: number): Promise<AgentEvent> {
    let found: AgentEvent | undefined;
    await waitFor(() => {
      if (!existsSync(path)) return false;
      found = readJsonlFile(path).events.find(pred);
      return found !== undefined;
    }, timeoutMs, "session event");
    return found as AgentEvent;
  }
}
