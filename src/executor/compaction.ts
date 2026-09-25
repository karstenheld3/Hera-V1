// Checkpoint compaction (HERAV1EXEC-SP01 FR-04, IG-01, DD-02, DD-03; HERAV1EXEC-IP01 IS-05). Port of V1 compaction.py:
// usage-anchored projection, one compacting-role call, deterministic todo splice, fail-safe on any error.

import type { ResolvedRole } from "../config/load.ts";
import type { Message, ToolDefinition, Usage } from "../models.ts";
import type { ProviderAdapter } from "../providers/base.ts";
import type { Gate } from "../harness/gate.ts";
import { egressModelInvoke } from "../providers/registry.ts";
import type { EmitFn } from "../harness/sink.ts";

export const CHECKPOINT_HEADER = "The following is a summary of important context from your previous session.\n{{ CHECKPOINT 1 }}";
export const ANCHOR_TODO_TITLE = "# Current working TODO list (keep this up to date with todo_list tool):";
export const ANCHOR_TODO_FOOTER = "Make sure to continue working off of this TODO list";
export const ANCHOR_NO_ACK = "DO NOT ACKNOWLEDGE THIS CHECKPOINT MESSAGE.";
export const COMPACTING_SYSTEM = "You are a conversation summarizer. Produce exactly three labeled Markdown sections: '# Objective:', '# Session Summary:', '# Code Interaction Summary:'. Be factual and concise; never invent content.";
export const KEEP_TAIL_MESSAGES = 6;

export function projectTokens(anchorTokens: number, charsSinceAnchor: number): number {
  return anchorTokens + Math.floor(charsSinceAnchor / 4);
}

/** Anchor = usage of the last assistant message carrying usage; delta = chars of messages after it. */
export function projectFromMessages(messages: readonly Message[]): number {
  let anchorTokens = 0;
  let anchorIndex = -1;
  for (const [i, m] of messages.entries()) {
    if (m.role === "assistant" && m.usage !== undefined) {
      anchorTokens = m.usage.uncachedInput + m.usage.cacheRead + m.usage.cacheWrite + m.usage.output;
      anchorIndex = i;
    }
  }
  let chars = 0;
  for (let i = anchorIndex + 1; i < messages.length; i++) {
    const m = messages[i]!;
    chars += m.content.length;
    for (const c of m.toolCalls ?? []) chars += c.argsJson.length;
  }
  return projectTokens(anchorTokens, chars);
}

export function compactionThreshold(fraction: number, maxTokens: number, generating: ResolvedRole): number {
  const maxInput = generating.maxInput ?? generating.contextWindow ?? 128000;
  return Math.min(Math.floor(fraction * maxInput), maxTokens);
}

export function shouldCompact(projected: number, threshold: number): boolean {
  return projected >= threshold;
}

/** Estimates the complete outgoing request size in tokens: system prompt + tool definitions JSON + conversation messages (FR-04 pre-call fit check). */
export function estimateRequestSize(systemPrompt: string, tools: readonly ToolDefinition[], messages: readonly Message[]): number {
  let chars = systemPrompt.length;
  chars += JSON.stringify(tools).length;
  for (const m of messages) {
    chars += m.content.length;
    for (const c of m.toolCalls ?? []) chars += c.argsJson.length + (c.result ?? "").length;
  }
  return Math.floor(chars / 4);
}

/** Returns true if the estimated request fits within the generating model's max_input. */
export function fitsWindow(estimated: number, maxInput: number): boolean {
  return estimated <= maxInput;
}

/** Drops oldest tool-role messages until the message count is at or below floor; returns the new array and the number dropped. */
export function dropOldToolResults(messages: readonly Message[], floor: number): { messages: Message[]; dropped: number } {
  const result = [...messages];
  let dropped = 0;
  while (result.length > floor && result.some((m) => m.role === "tool")) {
    const idx = result.findIndex((m) => m.role === "tool");
    if (idx === -1) break;
    result.splice(idx, 1);
    dropped++;
  }
  return { messages: result, dropped };
}

export function buildCheckpoint(objective: string, summary: string, codeHistory: string, todoJson: string | undefined): string {
  const parts = [CHECKPOINT_HEADER, "# Objective:", objective.trim()];
  if (todoJson !== undefined) parts.push(ANCHOR_TODO_TITLE, todoJson, ANCHOR_TODO_FOOTER);
  parts.push("# Session Summary:", summary.trim(), "# Code Interaction Summary:", codeHistory.trim(), ANCHOR_NO_ACK);
  return parts.join("\n\n");
}

export function splitSections(text: string): { objective: string; summary: string; codeHistory: string } {
  const sections = { objective: "", summary: "", codeHistory: "" };
  let current: keyof typeof sections | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#+\s*(objective|session summary|code interaction summary)\s*:?\s*$/i.exec(line.trim());
    if (heading !== null) {
      const key = (heading[1] as string).toLowerCase();
      current = key === "objective" ? "objective" : key === "session summary" ? "summary" : "codeHistory";
      continue;
    }
    if (current !== undefined) sections[current] += `${line}\n`;
  }
  if (sections.objective.trim().length === 0 && sections.summary.trim().length === 0 && sections.codeHistory.trim().length === 0) sections.summary = text;
  return sections;
}

export function renderTranscript(messages: readonly Message[], limitChars = 100000): string {
  const lines: string[] = [];
  for (const m of messages) {
    lines.push(`[${m.role.toUpperCase()}] ${m.content.slice(0, 2000)}`);
    for (const c of m.toolCalls ?? []) lines.push(`  [TOOL_CALL] ${c.name} ${c.argsJson.slice(0, 300)} -> ${String(c.result ?? "").slice(0, 300)}`);
  }
  const text = lines.join("\n");
  return text.length > limitChars ? text.slice(-limitChars) : text;
}

export interface CompactionOutcome {
  messages: Message[];
  checkpointText: string;
  truncated: number;
  kept: number;
  usage: Usage;
}

/** Runs the compacting call and builds the new message list; throws on any failure so the caller applies the fail-safe. */
export async function compact(messages: readonly Message[], role: ResolvedRole, adapter: ProviderAdapter, todoJson: string | undefined, gate: Gate, signal?: AbortSignal, emit?: EmitFn): Promise<CompactionOutcome> {
  const request: Message = { role: "user", content: `Summarize this agent conversation into the three required sections.\n\nTranscript:\n${renderTranscript(messages)}` };
  let text = "";
  let usage: Usage = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for await (const delta of egressModelInvoke(adapter, gate, { system: COMPACTING_SYSTEM, tools: [], messages: [request], role }, signal, emit)) {
    if (delta.kind === "text") text += delta.text;
    else if (delta.kind === "usage") usage = delta.usage;
  }
  if (text.trim().length === 0) throw new Error("compacting model returned no text");
  const { objective, summary, codeHistory } = splitSections(text);
  const checkpointText = buildCheckpoint(objective, summary, codeHistory, todoJson);
  let tail = messages.length > KEEP_TAIL_MESSAGES ? messages.slice(-KEEP_TAIL_MESSAGES) : [...messages];
  let cut = 0;
  while (cut < tail.length && tail[cut]?.role === "tool") cut++;
  if (cut > 0) tail = tail.slice(cut);
  const truncated = messages.length - tail.length;
  const summarizedRefs: string[] = [];
  for (const m of messages.slice(0, truncated)) {
    if (m.origin !== undefined) {
      const r = m.origin.ref;
      if (Array.isArray(r)) summarizedRefs.push(...r); else summarizedRefs.push(r);
    }
  }
  return { messages: [{ role: "user", content: checkpointText, origin: { kind: "model", ref: summarizedRefs.length > 0 ? summarizedRefs : "compaction" } }, ...tail], checkpointText, truncated, kept: tail.length, usage };
}
