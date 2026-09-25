// Category 07 Process Health (HERAV1STST-SP01 FR-10, IG-06; HERAV1STST-IP01 IS-05): spawns the real Executor and
// Supervisor through the Communicator's own spawn and handshake code (spawnChild, IpcChannel) with the scripted adapter
// pointed at an empty script, checks hello, session_open acknowledgement, heartbeat, shutdown order, ripgrep, ready time.
// `finally` kills any survivor - the category never leaves a process alive.
// U12: ripgrep spawn goes through the spawn wrapper (HERAV1HRNS-SP01 FR-10).

import { spawn as harnessSpawn } from "../../harness/spawn.ts";

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildRole } from "../../models.ts";
import { spawnChild } from "../../process/bootstrap.ts";
import type { IpcMessage, PayloadOf } from "../../process/envelope.ts";
import { IpcChannel } from "../../process/ipc.ts";
import type { TestResult } from "../report.ts";
import type { SelftestContext } from "../runner.ts";

export const READY_TARGET_MS = 500;

interface Child {
  role: ChildRole;
  proc: BunSubprocess | undefined;
  channel: IpcChannel | undefined;
  hello: Promise<PayloadOf<"hello">>;
  heartbeat: Promise<void>;
  exited: Promise<number | null>;
  spawnedAt: number;
  exitCode: number | null | undefined;
}

export async function processHealthCategory(ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const add = (check: string, status: "pass" | "fail", detail: string, seconds = 0, error?: string, warning?: string): void => {
    results.push({ category: "07", check, status, duration_seconds: seconds, detail, error_message: error ?? null, ...(warning !== undefined ? { warning } : {}) });
  };
  const tempRoot = join(tmpdir(), `hera-selftest-07-${process.pid}-${Date.now()}`);
  mkdirSync(join(tempRoot, "sessions"), { recursive: true });
  const script = join(tempRoot, "empty-script.jsonl");
  writeFileSync(script, "");
  const env: Record<string, string | undefined> = { ...ctx.env, HERA_SCRIPTED_ADAPTER: script };
  delete env["HERA_DEBUG_LINES"];
  const cfg = ctx.config.config.ipc;
  const children: Child[] = [];
  const spawnOne = (role: ChildRole): Child => {
    const spawnedAt = performance.now();
    let resolveHello: ((p: PayloadOf<"hello">) => void) | undefined;
    let resolveBeat: (() => void) | undefined;
    let resolveExit: ((code: number | null) => void) | undefined;
    const child: Child = {
      role,
      proc: undefined,
      channel: undefined,
      hello: new Promise((r) => (resolveHello = r)),
      heartbeat: new Promise((r) => (resolveBeat = r)),
      exited: new Promise((r) => (resolveExit = r)),
      spawnedAt,
      exitCode: undefined,
    };
    child.proc = spawnChild(role, 1, { // harness-allow: U12 spawnChild()
      cwd: ctx.appDir,
      env,
      main: ctx.entryMain,
      onMessage: (raw) => child.channel?.dispatch(raw),
      onExit: (code) => {
        child.exitCode = code;
        resolveExit?.(code);
      },
    });
    child.channel = new IpcChannel({ self: "comm", peer: role === "executor" ? "exec" : "sup", transport: { send: (m) => child.proc!.send(m) } });
    child.channel.onMessage((msg: IpcMessage) => {
      if (msg.type === "hello") resolveHello?.(msg.payload);
      else if (msg.type === "heartbeat") resolveBeat?.();
      else if (msg.type === "event") child.channel?.ack(msg.id);
    });
    return child;
  };
  const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms))]);
  const started = performance.now();
  try {
    for (const role of ["executor", "supervisor"] as ChildRole[]) children.push(spawnOne(role));
    const helloParts: string[] = [];
    let readyAt = 0;
    for (const c of children) {
      const t = performance.now();
      try {
        const hello = await withTimeout(c.hello, cfg.hello_timeout_ms, `no hello from ${c.role}`);
        const ms = Math.round(performance.now() - c.spawnedAt);
        readyAt = Math.max(readyAt, performance.now());
        add(`hello_${c.role}`, "pass", `pid='${hello.pid}', hello in ${ms} ms (v${hello.version}${hello.standalone ? ", standalone" : ""})`, Math.round((performance.now() - t) / 100) / 10);
        helloParts.push(`spawn ${c.role}: pid='${hello.pid}', hello in ${ms} ms...OK`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        add(`hello_${c.role}`, "fail", "no hello", Math.round((performance.now() - t) / 100) / 10, `${c.role}: ${message}`);
        helloParts.push(`spawn ${c.role}: ${message}...FAIL`);
      }
    }
    ctx.out(`  ${helloParts.join(" | ")}`);
    const readyMs = Math.round(readyAt - started);
    const jsonl = join(tempRoot, "sessions", "selftest.jsonl");
    const openPayload: PayloadOf<"session_open"> = { session_id: "selftest", jsonl_path: jsonl, mode: "new", workspace: ctx.appDir, app_dir: ctx.appDir, config_path: ctx.config.configPath };
    const t2 = performance.now();
    try {
      await Promise.all(children.filter((c) => c.exitCode === undefined).map((c) => c.channel!.sendAwaitAck("session_open", openPayload, Math.max(30000, cfg.ack_timeout_ms))));
      add("session_open_ack", "pass", "both acknowledged", Math.round((performance.now() - t2) / 100) / 10);
      ctx.out(`  session_open: both acknowledged (${Math.round(performance.now() - t2)} ms)...OK`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      add("session_open_ack", "fail", "not acknowledged", Math.round((performance.now() - t2) / 100) / 10, message);
      ctx.out(`  session_open: ${message}...FAIL`);
    }
    const beatParts: string[] = [];
    for (const c of children) {
      const t = performance.now();
      try {
        await withTimeout(c.heartbeat, 2 * cfg.heartbeat_s * 1000 + 1000, `no heartbeat from ${c.role}`);
        add(`heartbeat_${c.role}`, "pass", `first beat after ${Math.round(performance.now() - c.spawnedAt)} ms (interval ${cfg.heartbeat_s} s)`, Math.round((performance.now() - t) / 100) / 10);
        beatParts.push(`${c.role} ${cfg.heartbeat_s}.0 s...OK`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        add(`heartbeat_${c.role}`, "fail", "no heartbeat", Math.round((performance.now() - t) / 100) / 10, message);
        beatParts.push(`${c.role}: ${message}...FAIL`);
      }
    }
    ctx.out(`  heartbeat: ${beatParts.join(" | ")}`);
    const shutdownParts: string[] = [];
    for (const c of children) {
      const t = performance.now();
      try {
        c.channel!.send("shutdown", { reason: "selftest" });
      } catch {
        /* channel gone */
      }
      const code = await Promise.race([c.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), cfg.shutdown_timeout_ms))]);
      const ms = Math.round(performance.now() - t);
      if (code === "timeout") {
        c.proc!.kill();
        add(`shutdown_${c.role}`, "fail", `no exit within ${cfg.shutdown_timeout_ms} ms - killed`, Math.round(ms / 100) / 10, `${c.role} did not exit on shutdown within ${cfg.shutdown_timeout_ms} ms`);
        shutdownParts.push(`${c.role} killed after ${ms} ms...FAIL`);
      } else {
        add(`shutdown_${c.role}`, code === 0 ? "pass" : "fail", `exit ${code} (${ms} ms)`, Math.round(ms / 100) / 10, code === 0 ? undefined : `${c.role} exited with code ${code}`);
        shutdownParts.push(`${c.role} ${code} (${ms} ms)...${code === 0 ? "OK" : "FAIL"}`);
      }
    }
    ctx.out(`  shutdown: ${shutdownParts.join(", ")}`);
    // ripgrep: the tool path the Executor uses (HERAV1TOOL-IP01) - materialization is the distribution's hook (not in this prompt)
    const rg = join(ctx.appDir, ".agent-tools", process.platform === "win32" ? "rg.exe" : "rg");
    if (!existsSync(rg)) {
      add("rg_present", "fail", "missing", 0, `ripgrep not found at '${rg}' - run the distributed binary once to materialize it, or copy rg.exe into .agent-tools/`);
      ctx.out(`  rg.exe: missing at ${rg}...FAIL`);
    } else {
      add("rg_present", "pass", rg);
      const t = performance.now();
      try {
        const proc = harnessSpawn([rg, "--version"], { kind: "tool", cwd: ctx.appDir, stdout: "pipe", stderr: "pipe" });
        const code = await proc.exited;
        const text = (await new Response(proc.stdout as ReadableStream).text()).split(/\r?\n/)[0] ?? "";
        add("rg_version", code === 0 ? "pass" : "fail", text, Math.round((performance.now() - t) / 100) / 10, code === 0 ? undefined : `rg --version exited ${code}`);
        ctx.out(`  rg.exe: ${text}...${code === 0 ? "OK" : "FAIL"}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        add("rg_version", "fail", "cannot run", Math.round((performance.now() - t) / 100) / 10, message);
        ctx.out(`  rg.exe: ${message}...FAIL`);
      }
    }
    const readyWarning = readyMs > READY_TARGET_MS ? `ready in ${readyMs} ms exceeds the ${READY_TARGET_MS} ms target` : undefined;
    add("ready_ms", "pass", `${readyMs} ms (target ${READY_TARGET_MS})`, 0, undefined, readyWarning);
    ctx.out(`  ready in ${(readyMs / 1000).toFixed(2)} secs (target ${(READY_TARGET_MS / 1000).toFixed(2)})...OK${readyWarning !== undefined ? " (warning)" : ""}`);
  } finally {
    const survivors: string[] = [];
    for (const c of children) {
      if (c.exitCode === undefined) {
        try {
          c.proc?.kill();
          survivors.push(c.role);
        } catch {
          /* already gone */
        }
      }
    }
    if (survivors.length > 0) {
      add("survivors", "fail", survivors.join(", "), 0, `child survived shutdown and was killed: ${survivors.join(", ")}`);
      ctx.out(`  survivors killed: ${survivors.join(", ")}...FAIL`);
    }
    await Bun.sleep(100);
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return results;
}
