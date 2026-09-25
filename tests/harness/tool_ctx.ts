// ToolContext factory for tool tests (HERAV1TOOL-TP01 section 8).

import type { ToolCall } from "../../src/models.ts";
import type { ProviderAdapter } from "../../src/providers/base.ts";
import type { AskUserAnswer, AskUserRequest, ToolContext } from "../../src/tools/registry.ts";
import type { Gate } from "../../src/harness/gate.ts";
import { allowAllGate } from "../helpers/gate.ts";
import { REPO_ROOT } from "./procs.ts";

export interface FakeChildren {
  registered: Array<{ pid: number; description: string }>;
  deregistered: number[];
  live(): number[];
}

export function fakeChildren(): FakeChildren & ToolContext["children"] {
  const registered: Array<{ pid: number; description: string }> = [];
  const deregistered: number[] = [];
  return {
    registered,
    deregistered,
    live: () => registered.map((r) => r.pid).filter((p) => !deregistered.includes(p)),
    register: (pid, description) => registered.push({ pid, description }),
    deregister: (pid) => deregistered.push(pid),
  };
}

export interface ToolCtxOptions {
  workspace?: string;
  appDir?: string;
  runCtx?: string;
  maxChars?: number;
  askUser?: (req: AskUserRequest) => Promise<AskUserAnswer>;
  websearch?: ProviderAdapter | undefined;
  signal?: AbortSignal;
  sessionsDir?: string;
  timeouts?: ToolContext["timeouts"];
  gate?: Gate;
}

export function toolCtx(opts: ToolCtxOptions = {}): ToolContext & { children: FakeChildren & ToolContext["children"] } {
  const controller = new AbortController();
  return {
    workspace: opts.workspace ?? REPO_ROOT,
    appDir: opts.appDir ?? REPO_ROOT,
    runCtx: opts.runCtx,
    limits: { toolResultMaxChars: opts.maxChars ?? 50000 },
    promptSystem: undefined,
    askUser: opts.askUser ?? (() => Promise.reject(new Error("askUser not configured"))),
    children: fakeChildren(),
    adapters: { websearch: opts.websearch, websearchRole: undefined },
    sessions: { dir: opts.sessionsDir ?? REPO_ROOT },
    state: { todo: [] },
    signal: opts.signal ?? controller.signal,
    timeouts: opts.timeouts,
    gate: opts.gate ?? allowAllGate(),
  };
}

let counter = 0;
export function call(name: string, args: Record<string, unknown> | string): ToolCall {
  counter++;
  return { id: `tc_${String(counter).padStart(4, "0")}`, name, argsJson: typeof args === "string" ? args : JSON.stringify(args), status: "pending" };
}
