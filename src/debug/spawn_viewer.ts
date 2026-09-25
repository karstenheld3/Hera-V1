// Viewer spawn (HERAV1DEBG-SP01 DD-07, DD-08 re-evaluated in Prompt 9; HERAV1DEBG-IP01 IS-03).
// Finding: under Bun a detached child on Windows gets NO console (libuv DETACHED_PROCESS, not CREATE_NEW_CONSOLE), so
// the stdin-pipe design cannot open a window. The viewer therefore starts through `cmd /c start` (a real new console)
// and connects back over a loopback TCP socket the Communicator listens on; the socket replaces the stdin pipe as the
// line transport. stdout/stderr of the viewer never touch the Communicator's handles. Non-Windows: no spawn (stderr
// fallback only; the terminal spawn is deferred).

import { fileURLToPath } from "node:url";
import type { PipeWriter } from "./debuglog.ts";
import { spawn as harnessSpawn } from "../harness/spawn.ts";

/**
 * Recursion guard (HERAV1-FL-0002): a process spawned as a viewer carries this variable and must never spawn another
 * viewer. Without it, a wrong entry path turned one spawn into an unbounded cascade of console windows.
 */
export const VIEWER_GUARD_ENV = "HERA_VIEWER_SPAWNED";

/** The package entry `src/index.ts` resolved from this module - never `Bun.main`, which is the CALLER's script under `bun run` (tests, probes). */
export const PACKAGE_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));

export interface ViewerHandle {
  /** loopback port the viewer connects to */
  port: number;
  writer: PipeWriter;
  connected(): boolean;
  alive(): boolean;
  close(): void;
}

export interface SpawnViewerOptions {
  /** viewer command without the `--connect` argument (default: this executable's `--debug-viewer`) */
  command?: string[];
  platform?: string;
  env?: Record<string, string | undefined>;
  /** how long buffered lines wait for the viewer's connection before the link counts as failed */
  connectTimeoutMs?: number;
  /** spawn through `cmd /c start` (default true on win32); false = plain spawn with detached stdio (tests) */
  newWindow?: boolean;
  onWarning: (line: string) => void;
}

export function viewerCommand(): string[] {
  return Bun.isStandaloneExecutable ? [process.execPath, "--debug-viewer"] : [process.execPath, "run", PACKAGE_ENTRY, "--debug-viewer"];
}

const quote = (s: string): string => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Returns the viewer handle, or null when the platform has no console spawn or the spawn failed (warning printed once). */
export function spawnViewer(opts: SpawnViewerOptions): ViewerHandle | null {
  const platform = opts.platform ?? process.platform;
  const ownEnv = opts.env ?? process.env;
  if (ownEnv[VIEWER_GUARD_ENV] !== undefined) {
    opts.onWarning("ERROR: refusing to spawn a debug viewer from a process that is itself a spawned viewer (recursion guard).");
    return null;
  }
  if (platform !== "win32") {
    opts.onWarning("NOTICE: debug console window is Windows-only in this build - debug lines go to the log file (--log-dir) only.");
    return null;
  }
  let socket: Bun.Socket | undefined;
  let closed = false;
  let processExited = false;
  const waiting: Array<{ text: string; resolve: () => void; reject: (e: Error) => void }> = [];
  const failAll = (error: Error): void => {
    closed = true;
    for (const w of waiting.splice(0)) w.reject(error);
  };
  let listener: Bun.TCPSocketListener;
  try {
    listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (s) => {
          if (socket !== undefined) {
            s.end();
            return;
          }
          socket = s;
          clearTimeout(connectTimeout);
          for (const w of waiting.splice(0)) {
            try {
              s.write(w.text);
              w.resolve();
            } catch (error) {
              w.reject(error instanceof Error ? error : new Error(String(error)));
            }
          }
        },
        data: () => undefined,
        close: () => {
          if (!closed) failAll(new Error("viewer closed"));
          listener.stop(true);
        },
        error: (_s, error) => failAll(error),
      },
    });
  } catch (error) {
    opts.onWarning(`WARNING: debug console listener failed (${error instanceof Error ? error.message : String(error)}) -> viewer logging disabled for this session.`);
    return null;
  }
  const port = listener.port;
  const command = [...(opts.command ?? viewerCommand()), "--connect", `127.0.0.1:${port}`];
  const env = { ...ownEnv, [VIEWER_GUARD_ENV]: "1" };
  if (command.some((part) => /--debug-viewer/.test(part)) === false) {
    listener.stop(true);
    opts.onWarning("ERROR: viewer command lacks --debug-viewer -> spawn refused.");
    return null;
  }
  try {
    const cmd = opts.newWindow === false ? command : ["cmd.exe", "/d", "/c", "start", "\"Hera Debug Console\"", ...command.map(quote)];
    const child = harnessSpawn(cmd, {
      kind: "trusted",
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: opts.newWindow !== false,
      onExit: () => {
        processExited = true;
      },
    });
    if (opts.newWindow !== false) child.unref();
  } catch (error) {
    listener.stop(true);
    opts.onWarning(`WARNING: debug console spawn failed (${error instanceof Error ? error.message : String(error)}) -> viewer logging disabled for this session.`);
    return null;
  }
  const connectTimeout = setTimeout(() => {
    if (socket === undefined && !closed) {
      failAll(new Error(`viewer did not connect within ${opts.connectTimeoutMs ?? 5000} ms`));
      listener.stop(true);
    }
  }, opts.connectTimeoutMs ?? 5000);
  const writer: PipeWriter = {
    write: (text) =>
      new Promise<void>((resolve, reject) => {
        if (closed) {
          reject(new Error("viewer closed"));
          return;
        }
        if (socket === undefined) {
          waiting.push({ text, resolve, reject });
          return;
        }
        try {
          socket.write(text);
          resolve();
        } catch (error) {
          failAll(error instanceof Error ? error : new Error(String(error)));
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    close: () => {
      clearTimeout(connectTimeout);
      closed = true;
      try {
        socket?.end();
      } catch {
        /* already gone */
      }
      listener.stop(true);
    },
  };
  return { port, writer, connected: () => socket !== undefined, alive: () => !closed && (socket !== undefined || !processExited), close: () => writer.close?.() };
}
