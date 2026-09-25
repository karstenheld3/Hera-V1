// Communicator-side debug setup (HERAV1DEBG-SP01 FR-01, FR-02): `--debug-console` opens the viewer (pipe sink),
// `--log-dir` opens the file sink; both feed the same dlog(). Children get HERA_DEBUG_LINES only when a sink is active.

import { FileSink, PipeSink, enable, type Sink } from "./debuglog.ts";
import { spawnViewer } from "./spawn_viewer.ts";

export interface DebugSetupOptions {
  debugConsole: boolean;
  logDir: string | undefined;
  /** stderr-style notice sink (never stdout: ACP purity) */
  notice: (line: string) => void;
  env?: Record<string, string | undefined>;
}

export interface DebugSetup {
  enabled: boolean;
  /** value for the children's HERA_DEBUG_LINES ("1") or undefined to clear a stale variable */
  childEnv: string | undefined;
  logPath: string | undefined;
  viewerPort: number | undefined;
  close(): Promise<void>;
}

export function setupDebug(opts: DebugSetupOptions): DebugSetup {
  const sinks: Sink[] = [];
  let logPath: string | undefined;
  let viewerPort: number | undefined;
  if (opts.logDir !== undefined) {
    const file = new FileSink(opts.logDir, opts.notice);
    if (!file.disabled) {
      sinks.push(file);
      logPath = file.path;
    }
  }
  if (opts.debugConsole) {
    const viewer = spawnViewer({ env: opts.env, onWarning: opts.notice });
    if (viewer !== null) {
      sinks.push(new PipeSink(viewer.writer, opts.notice));
      viewerPort = viewer.port;
      opts.notice(`Debug console opened (loopback port ${viewer.port}).`);
    }
  }
  const enabled = sinks.length > 0 && enable({ proc: "comm", sinks, stderr: opts.notice });
  return {
    enabled,
    childEnv: enabled ? "1" : undefined,
    logPath,
    viewerPort,
    close: async () => {
      for (const s of sinks) await s.flush?.();
      for (const s of sinks) s.close?.();
    },
  };
}
