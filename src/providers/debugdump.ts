// Debug request/response dumps (HERAV1PRVD-SP01 FR-06 --debug; HERAV1PRVD-IP01 IS-07). Keys are redacted in headers and
// in any key-shaped string; an unwritable directory produces one warning, never an error.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcId } from "../models.ts";
import { redactKeyShapes } from "../harness/plugs/keyshapes.ts";

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "api-key", "cookie", "set-cookie"]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 32) return "***";
  if (typeof value === "string") return redactKeyShapes(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? "***" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class DebugDumper {
  private counter = 0;
  private warned = false;

  constructor(
    readonly dir: string,
    readonly proc: ProcId,
    private readonly warn: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
  ) {}

  private stamp(): string {
    const d = new Date();
    const p2 = (n: number): string => String(n).padStart(2, "0");
    const p3 = (n: number): string => String(n).padStart(3, "0");
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${p3(d.getMilliseconds())}`;
  }

  private write(kind: "request" | "response", role: string, body: unknown): string | undefined {
    const name = `${this.stamp()}_${String(++this.counter).padStart(4, "0")}_${this.proc}_${role}_${kind}.json`;
    const path = join(this.dir, name);
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify(redact(body), null, 2)}\n`);
      return path;
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.warn(`WARNING: debug dump to '${this.dir}' failed -> ${error instanceof Error ? error.message : String(error)}; further dumps skipped.`);
      }
      return undefined;
    }
  }

  request(role: string, body: unknown): string | undefined {
    return this.write("request", role, body);
  }

  response(role: string, body: unknown): string | undefined {
    return this.write("response", role, body);
  }
}
