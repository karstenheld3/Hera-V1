// Tool registry and dispatch (HERAV1TOOL-SP01 FR-09; HERAV1TOOL-IP01 IS-02). Arguments are parsed and validated against
// the verbatim JSON Schema before an executor runs; every failure becomes a `ToolResult` with status error - the tool layer
// never throws into the turn loop. `blocked` is set by the Executor from the guard verdict, never here (spec 05 DD-07).

import { ToolError } from "../errors.ts";
import type { TodoItem, ToolCall, ToolDefinition } from "../models.ts";
import type { PromptSystem } from "../prompt/loader.ts";
import type { ProviderAdapter } from "../providers/base.ts";
import type { ResolvedRole } from "../config/load.ts";
import type { Gate } from "../harness/gate.ts";

export interface ToolResult {
  status: "ok" | "error" | "cancelled";
  text: string;
  meta?: { host?: string; childPid?: number; commandId?: string };
}

/** Child process ownership hooks (spec 05 DD-09): the Executor sees every pid the tools spawn. */
export interface ChildRegistryHooks {
  register(pid: number, description: string): void;
  deregister(pid: number): void;
}

export interface AskUserRequest {
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowMultiple: boolean;
}

export interface AskUserAnswer {
  selected?: string[];
  text?: string;
}

export interface ToolContext {
  workspace: string;
  appDir: string;
  runCtx?: string;
  limits: { toolResultMaxChars: number };
  promptSystem: PromptSystem | undefined;
  askUser(req: AskUserRequest): Promise<AskUserAnswer>;
  children: ChildRegistryHooks;
  adapters: { websearch: ProviderAdapter | undefined; websearchRole: ResolvedRole | undefined };
  sessions: { dir: string };
  state: { todo: TodoItem[] };
  signal: AbortSignal;
  /** the gate socket for non-tool effects (net.egress, process.spawn, model.invoke) */
  gate?: Gate;
  /** test hooks */
  timeouts?: { searchMs?: number; fetchMs?: number };
  os?: { platform?: string };
  hooks?: { mapSearchArgv?(argv: string[]): string[] };
}

export type ToolExecutor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export class ToolRegistry {
  private readonly executors = new Map<string, ToolExecutor>();
  private readonly definitions = new Map<string, ToolDefinition>();

  constructor(definitions: readonly ToolDefinition[]) {
    for (const d of definitions) this.definitions.set(d.name, d);
  }

  register(name: string, executor: ToolExecutor): void {
    if (!this.definitions.has(name)) throw new Error(`no definition for tool '${name}'`);
    this.executors.set(name, executor);
  }

  has(name: string): boolean {
    return this.executors.has(name);
  }

  names(): string[] {
    return [...this.executors.keys()];
  }

  definition(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  async dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const definition = this.definitions.get(call.name);
    const executor = this.executors.get(call.name);
    if (definition === undefined || executor === undefined) return { status: "error", text: `unknown tool '${call.name}'. Available tools: ${this.names().join(", ")}.` };
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.argsJson.trim().length === 0 ? {} : JSON.parse(call.argsJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { status: "error", text: `${call.name}: arguments must be a JSON object.` };
      args = parsed as Record<string, unknown>;
    } catch (error) {
      return { status: "error", text: `${call.name}: arguments are not valid JSON (${error instanceof Error ? error.message : String(error)}).` };
    }
    const problems = validateAgainstSchema(args, definition.parameters, "");
    if (problems.length > 0) return { status: "error", text: `${call.name}: invalid arguments - ${problems.join("; ")}.` };
    if (ctx.signal.aborted) return { status: "cancelled", text: "cancelled before execution." };
    try {
      const result = await executor(args, ctx);
      if (ctx.signal.aborted && result.status === "ok") return { status: "cancelled", text: capResult(result.text, ctx.limits.toolResultMaxChars) };
      return { ...result, text: capResult(result.text, ctx.limits.toolResultMaxChars) };
    } catch (error) {
      if (ctx.signal.aborted) return { status: "cancelled", text: "cancelled during execution." };
      if (error instanceof ToolError) return { status: "error", text: capResult(error.message, ctx.limits.toolResultMaxChars) };
      return { status: "error", text: capResult(`internal tool failure: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`, ctx.limits.toolResultMaxChars) };
    }
  }
}

export function capResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n<truncated ${text.length - maxChars} chars>`;
}

type Schema = Record<string, unknown>;

/** Validates the JSON-Schema subset the 15 definitions use: object, string, integer, number, boolean, array, enum, required, minItems, additionalProperties. */
export function validateAgainstSchema(value: unknown, schema: Schema, path: string): string[] {
  const problems: string[] = [];
  const label = path.length > 0 ? path : "arguments";
  const type = schema["type"];
  const enumValues = schema["enum"] as unknown[] | undefined;
  if (enumValues !== undefined && !enumValues.includes(value)) {
    problems.push(`'${label}' must be one of ${enumValues.map((v) => JSON.stringify(v)).join(", ")}`);
    return problems;
  }
  switch (type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [`'${label}' must be an object`];
      const obj = value as Record<string, unknown>;
      const props = (schema["properties"] as Record<string, Schema> | undefined) ?? {};
      for (const req of (schema["required"] as string[] | undefined) ?? []) if (!(req in obj)) problems.push(`missing required parameter '${path.length > 0 ? `${path}.` : ""}${req}'`);
      for (const [k, v] of Object.entries(obj)) {
        const sub = props[k];
        const childPath = path.length > 0 ? `${path}.${k}` : k;
        if (sub === undefined) {
          if (schema["additionalProperties"] === false) problems.push(`unknown parameter '${childPath}'`);
          continue;
        }
        problems.push(...validateAgainstSchema(v, sub, childPath));
      }
      return problems;
    }
    case "string":
      if (typeof value !== "string") problems.push(`'${label}' must be a string`);
      return problems;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) problems.push(`'${label}' must be an integer`);
      return problems;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) problems.push(`'${label}' must be a number`);
      return problems;
    case "boolean":
      if (typeof value !== "boolean") problems.push(`'${label}' must be a boolean`);
      return problems;
    case "array": {
      if (!Array.isArray(value)) return [`'${label}' must be an array`];
      const min = schema["minItems"];
      if (typeof min === "number" && value.length < min) problems.push(`'${label}' must have at least ${min} item${min === 1 ? "" : "s"}`);
      const items = schema["items"] as Schema | undefined;
      if (items !== undefined) value.forEach((item, i) => problems.push(...validateAgainstSchema(item, items, `${label}[${i}]`)));
      return problems;
    }
    default:
      return problems;
  }
}
