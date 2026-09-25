// Category 01 Environment (HERAV1STST-SP01 FR-03; HERAV1STST-IP01 IS-04): runtime versions, platform, data dir write
// probe, TLS reachability of the three provider hosts (5 s timeout each; unreachable = fail naming the host, run continues).

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../version.ts";
import { checkLine, type TestResult } from "../report.ts";
import type { SelftestContext } from "../runner.ts";

export const PROVIDER_HOSTS = ["api.openai.com", "api.anthropic.com", "api.z.ai"];

const timed = <T>(fn: () => T): { value: T; seconds: number } => {
  const s = performance.now();
  const value = fn();
  return { value, seconds: Math.round((performance.now() - s) / 100) / 10 };
};

/** TLS handshake to host:443 with a timeout; resolves the round trip in ms or throws with the reason. */
export async function probeHost(host: string, timeoutMs = 5000): Promise<number> {
  const started = performance.now();
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`no TLS handshake within ${timeoutMs / 1000} s`))), timeoutMs);
    Bun.connect({
      hostname: host,
      port: 443,
      tls: true,
      socket: {
        open: (socket) => {
          finish(() => resolve(Math.round(performance.now() - started)));
          socket.end();
        },
        data: () => undefined,
        error: (_s, error) => finish(() => reject(error)),
        connectError: (_s, error) => finish(() => reject(error)),
        close: () => finish(() => reject(new Error("connection closed before the handshake"))),
      },
    }).catch((error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
  });
}

export async function environmentCategory(ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const parts: string[] = [];
  const push = (check: string, detail: string, status: "pass" | "fail", error?: string): void => {
    results.push({ category: "01", check, status, duration_seconds: 0, detail, error_message: error ?? null });
    parts.push(`${check}: ${detail}...${status === "pass" ? "OK" : "FAIL"}`);
  };
  push("bun_version", Bun.version, "pass");
  push("hera_version", VERSION, "pass");
  push("platform", `${process.platform} ${process.arch} ${Bun.isStandaloneExecutable ? "standalone" : "bun run"}`, "pass");
  const probe = timed(() => {
    try {
      mkdirSync(ctx.config.dataDir, { recursive: true });
      const file = join(ctx.config.dataDir, `.selftest-probe-${process.pid}`);
      writeFileSync(file, "probe");
      unlinkSync(file);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  if (probe.value === undefined) push("data_dir", "writable", "pass");
  else push("data_dir", `not writable (${probe.value})`, "fail", `data_dir '${ctx.config.dataDir}' not writable: ${probe.value}`);
  ctx.out(`  ${parts.join(" | ")}`);
  const hostParts: string[] = [];
  for (const host of PROVIDER_HOSTS) {
    if (ctx.signal.aborted) break;
    const started = performance.now();
    try {
      const ms = await probeHost(host);
      results.push({ category: "01", check: host, status: "pass", duration_seconds: Math.round((performance.now() - started) / 100) / 10, detail: `reachable (${ms} ms)`, error_message: null });
      hostParts.push(`${host}: reachable...OK`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ category: "01", check: host, status: "fail", duration_seconds: Math.round((performance.now() - started) / 100) / 10, detail: "unreachable", error_message: `${host}: ${message}` });
      hostParts.push(`${host}: unreachable (${message})...FAIL`);
    }
  }
  ctx.out(`  ${hostParts.join(" | ")}`);
  return results;
}

export { checkLine };
