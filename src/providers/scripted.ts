// Scripted replay adapter (HERAV1PRVD-SP01 FR-05, DD-09; HERAV1PRVD-IP01 IS-06). Port of V1 scripted_adapter.py with
// role-tagged lines and a per-role cursor. Lives in src/ so the compiled binary can run scripted sessions.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ResolvedRole } from "../config/load.ts";
import { ProviderError } from "../errors.ts";
import { STOP_REASONS, type ProviderId, type StopReason, type ThinkingBlock, type ToolCall, type Usage } from "../models.ts";
import type { AdapterDelta, ProviderAdapter, TurnRequest, WebSearchResult } from "./base.ts";

export const SCRIPTED_ENV = "HERA_SCRIPTED_ADAPTER";
export const SCRIPTED_CAPTURE_ENV = "HERA_SCRIPTED_CAPTURE";

export interface ScriptLine {
  role?: string;
  text?: string;
  thinking?: string;
  tool_calls?: Array<{ name: string; args?: Record<string, unknown> }>;
  usage?: { uncached_input?: number; cache_write?: number; cache_read?: number; output?: number; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; input?: number };
  notice?: string;
  stop_reason?: string;
  error?: string;
  web_results?: WebSearchResult[];
  /** pause between deltas (slow mode for cancellation tests) */
  delay_ms?: number;
}

const DEFAULT_ROLE = "generating";

function usageOf(spec: ScriptLine["usage"]): Usage {
  const u = spec ?? { input_tokens: 100, output_tokens: 10 };
  if (u.uncached_input !== undefined || u.cache_write !== undefined || u.cache_read !== undefined || u.output !== undefined) {
    return { uncachedInput: u.uncached_input ?? 0, cacheWrite: u.cache_write ?? 0, cacheRead: u.cache_read ?? 0, output: u.output ?? 0 };
  }
  const input = u.input_tokens ?? u.input ?? 0;
  const cacheRead = u.cache_read_tokens ?? u.cache_read ?? 0;
  const cacheWrite = u.cache_write_tokens ?? 0;
  return { uncachedInput: Math.max(0, input - cacheRead - cacheWrite), cacheWrite, cacheRead, output: u.output_tokens ?? u.output ?? 0 };
}

export class ScriptedAdapter implements ProviderAdapter {
  readonly provider: ProviderId = "scripted";
  readonly scriptPath: string;
  readonly scriptName: string;
  private readonly turns = new Map<string, ScriptLine[]>();
  private readonly webResults = new Map<string, WebSearchResult[][]>();
  private readonly cursors = new Map<string, number>();
  private readonly webCursors = new Map<string, number>();
  private callCounter = 0;
  private captureWarned = false;

  constructor(
    scriptPath: string,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly warn: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
  ) {
    this.scriptPath = scriptPath;
    this.scriptName = basename(scriptPath);
    if (!existsSync(scriptPath)) throw new ProviderError(`scripted adapter file '${scriptPath}' not found.`, `Fix ${SCRIPTED_ENV} or create the script.`, { provider: "scripted" });
    const lines = readFileSync(scriptPath, "utf8").split(/\r?\n/);
    for (const [index, raw] of lines.entries()) {
      if (raw.trim().length === 0) continue;
      let line: ScriptLine;
      try {
        line = JSON.parse(raw) as ScriptLine;
      } catch (error) {
        throw new ProviderError(`scripted adapter '${this.scriptName}' line ${index + 1} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`, "Fix the script line.", { provider: "scripted" });
      }
      const role = line.role ?? DEFAULT_ROLE;
      if (line.web_results !== undefined) {
        const list = this.webResults.get(role) ?? [];
        list.push(line.web_results);
        this.webResults.set(role, list);
      } else {
        const list = this.turns.get(role) ?? [];
        list.push(line);
        this.turns.set(role, list);
      }
    }
  }

  /** remaining turns per role (tests and the selftest) */
  remaining(role: string = DEFAULT_ROLE): number {
    return (this.turns.get(role)?.length ?? 0) - (this.cursors.get(role) ?? 0);
  }

  private nextTurn(role: string): ScriptLine {
    const list = this.turns.get(role) ?? [];
    const cursor = this.cursors.get(role) ?? 0;
    const line = list[cursor];
    if (line === undefined) {
      throw new ProviderError(`scripted adapter '${this.scriptName}' exhausted after ${list.length} turn${list.length === 1 ? "" : "s"} for role '${role}'.`, "Add script lines for this role.", { provider: "scripted", retryable: false });
    }
    this.cursors.set(role, cursor + 1);
    return line;
  }

  private capture(req: TurnRequest): void {
    const path = this.env[SCRIPTED_CAPTURE_ENV];
    if (path === undefined || path.length === 0) return;
    try {
      appendFileSync(path, `${JSON.stringify({ role: req.role.name, system: req.system, tools: req.tools, messages: req.messages })}\n`);
    } catch (error) {
      if (!this.captureWarned) {
        this.captureWarned = true;
        this.warn(`WARNING: ${SCRIPTED_CAPTURE_ENV} '${path}' not writable -> ${error instanceof Error ? error.message : String(error)}; capture disabled.`);
      }
    }
  }

  async *streamTurn(req: TurnRequest, signal?: AbortSignal): AsyncIterable<AdapterDelta> {
    this.capture(req);
    const role = req.role.name;
    const line = this.nextTurn(role);
    if (line.error !== undefined) {
      throw new ProviderError(`simulated provider failure: ${line.error}`, "Scripted failure - no retry.", { provider: "scripted", model: req.role.modelId, retryable: false });
    }
    const delay = line.delay_ms ?? 0;
    const thinkingPayloads: ThinkingBlock[] = [];
    const pause = async (): Promise<boolean> => {
      if (delay > 0) await Bun.sleep(delay);
      return signal?.aborted === true;
    };
    const cancelled = (): AdapterDelta => ({ kind: "usage", usage: { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, stopReason: "cancelled", thinkingPayloads });
    if (signal?.aborted === true) {
      yield cancelled();
      return;
    }
    if (line.thinking !== undefined && line.thinking.length > 0) {
      thinkingPayloads.push({ provider: "scripted", payload: { thinking: line.thinking } });
      yield { kind: "thinking", text: line.thinking };
      if (await pause()) {
        yield cancelled();
        return;
      }
    }
    if (line.text !== undefined && line.text.length > 0) {
      yield { kind: "text", text: line.text };
      if (await pause()) {
        yield cancelled();
        return;
      }
    }
    const toolCalls = line.tool_calls ?? [];
    for (const requested of toolCalls) {
      this.callCounter++;
      const call: ToolCall = { id: `tc_${String(this.callCounter).padStart(4, "0")}`, name: requested.name, argsJson: JSON.stringify(requested.args ?? {}), args: requested.args ?? {}, status: "pending" };
      yield { kind: "tool_call", toolCall: call };
      if (await pause()) {
        yield cancelled();
        return;
      }
    }
    if (line.notice !== undefined) yield { kind: "notice", text: line.notice };
    const stop = line.stop_reason !== undefined && (STOP_REASONS as readonly string[]).includes(line.stop_reason) ? (line.stop_reason as StopReason) : toolCalls.length > 0 ? "tool_calls" : "end";
    yield { kind: "usage", usage: usageOf(line.usage), stopReason: stop, thinkingPayloads };
  }

  supportsWebSearch(): boolean {
    return true;
  }

  webSearch(_query: string, role: ResolvedRole, _signal?: AbortSignal): Promise<WebSearchResult[]> {
    const list = this.webResults.get(role.name) ?? this.webResults.get(DEFAULT_ROLE) ?? [];
    const key = this.webResults.has(role.name) ? role.name : DEFAULT_ROLE;
    const cursor = this.webCursors.get(key) ?? 0;
    const result = list[cursor];
    if (result === undefined) return Promise.resolve([]);
    this.webCursors.set(key, cursor + 1);
    return Promise.resolve(result);
  }
}
