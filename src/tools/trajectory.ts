// trajectory_search over session JSONL files (HERAV1TOOL-SP01 FR-05, DD-06; HERAV1TOOL-IP01 IS-07). Lexical scoring only.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ToolError } from "../errors.ts";
import { fromJsonl, type AgentEvent } from "../events.ts";
import type { ToolContext, ToolResult } from "./registry.ts";

export const TRAJECTORY_MAX_CHUNKS = 50;
const EXCERPT_CHARS = 400;

/** Resolves a session id: exact file, stem, or unique prefix; ambiguity lists the candidates. */
export function resolveSessionFile(sessionsDir: string, id: string): string {
  if (!existsSync(sessionsDir)) throw new ToolError(`No sessions folder at '${sessionsDir}'.`, "Run at least one session first.");
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  const exact = files.find((f) => f === id || f === `${id}.jsonl`);
  if (exact !== undefined) return join(sessionsDir, exact);
  const stems = files.map((f) => f.replace(/\.jsonl$/, ""));
  const matches = stems.filter((s) => s.startsWith(id));
  if (matches.length === 1) return join(sessionsDir, `${matches[0]}.jsonl`);
  if (matches.length > 1) throw new ToolError(`Trajectory ID '${id}' is ambiguous: ${matches.sort().join(", ")}.`, "Use a longer prefix.");
  throw new ToolError(`Unknown trajectory ID '${id}'. Known sessions: ${stems.sort().slice(-10).join(", ") || "(none)"}.`, "Use one of the listed ids or a unique prefix.");
}

export function excerptOf(event: AgentEvent): string {
  switch (event.type) {
    case "user_message":
      return event.content;
    case "text_delta":
      return event.text;
    case "thinking_delta":
      return event.text;
    case "tool_call_requested":
      return `${event.tool} ${event.args_json ?? JSON.stringify(event.args)}`;
    case "tool_call_finished":
      return `${event.status}: ${event.result}`;
    case "error":
      return event.severity !== undefined ? `${event.severity}: ${event.message}` : event.message;
    case "supervisor_intervention":
      return event.text;
    default:
      return JSON.stringify(event).slice(0, EXCERPT_CHARS);
  }
}

const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);

export function scoreChunk(queryTerms: string[], text: string): number {
  if (queryTerms.length === 0) return 0;
  const words = new Set(tokens(text));
  let hits = 0;
  for (const q of queryTerms) if (words.has(q)) hits++;
  return hits / queryTerms.length;
}

export async function trajectorySearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (args["SearchType"] === "user") throw new ToolError("SearchType 'user' is not supported: Hera has no user activity trajectories, only conversations.", "Use SearchType 'conversation'.");
  const path = resolveSessionFile(ctx.sessions.dir, String(args["ID"]));
  const query = String(args["Query"] ?? "");
  const runCtx = ctx.runCtx;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const chunks: Array<{ index: number; type: string; ts: string; excerpt: string; score: number }> = [];
  const terms = tokens(query);
  let corrupt = 0;
  let skippedByRunCtx = 0;
  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let event: AgentEvent;
    try {
      event = fromJsonl(line, i + 1);
    } catch {
      corrupt++;
      continue;
    }
    if (runCtx !== undefined && "run_ctx" in event && (event as { run_ctx?: string }).run_ctx !== undefined && (event as { run_ctx?: string }).run_ctx !== runCtx) {
      skippedByRunCtx++;
      continue;
    }
    const excerpt = excerptOf(event).slice(0, EXCERPT_CHARS);
    chunks.push({ index: i + 1, type: event.type, ts: event.ts, excerpt, score: scoreChunk(terms, `${event.type} ${excerpt}`) });
  }
  let selected = chunks;
  if (terms.length > 0) selected = chunks.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  selected = selected.slice(0, TRAJECTORY_MAX_CHUNKS);
  await Promise.resolve();
  if (selected.length === 0) return { status: "ok", text: `No matching chunks in '${basename(path)}' for query '${query}'.${corrupt > 0 ? ` (${corrupt} corrupt line${corrupt === 1 ? "" : "s"} skipped)` : ""}` };
  const header = `${selected.length} chunk${selected.length === 1 ? "" : "s"} from '${basename(path)}'${terms.length > 0 ? ` for '${query}' (sorted by relevance)` : " (chronological)"}${corrupt > 0 ? `; ${corrupt} corrupt line${corrupt === 1 ? "" : "s"} skipped` : ""}:`;
  const body = selected.map((c) => `[line ${c.index}] ${c.ts} ${c.type}${terms.length > 0 ? ` (score ${c.score.toFixed(2)})` : ""}\n${c.excerpt}`);
  return { status: "ok", text: [header, ...body].join("\n\n") };
}
