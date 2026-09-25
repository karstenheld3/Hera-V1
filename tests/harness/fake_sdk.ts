// Fake SDK clients replaying recorded stream events from tests/fixtures/sse/*.jsonl (HERAV1PRVD-TP01 section 8).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnthropicClientLike } from "../../src/providers/anthropic.ts";
import type { OpenAIClientLike } from "../../src/providers/openai.ts";
import type { ChatClientLike } from "../../src/providers/zai.ts";
import { REPO_ROOT } from "./procs.ts";

export function loadEvents(name: string): Array<Record<string, unknown>> {
  const path = join(REPO_ROOT, "tests", "fixtures", "sse", `${name}.jsonl`);
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export interface FakeCall {
  params: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

export interface FakeScript {
  /** events for each successive call; a script entry that is an Error is thrown instead of streamed */
  responses: Array<Array<Record<string, unknown>> | Error | Record<string, unknown>>;
  /** ms between events (cancellation tests) */
  delayMs?: number;
}

export interface FakeSdk {
  calls: FakeCall[];
  openai: OpenAIClientLike;
  anthropic: AnthropicClientLike;
  chat: ChatClientLike;
}

async function* replay(events: Array<Record<string, unknown>>, delayMs: number): AsyncGenerator<Record<string, unknown>> {
  for (const e of events) {
    if (delayMs > 0) await Bun.sleep(delayMs);
    yield e;
  }
}

export function fakeSdk(script: FakeScript): FakeSdk {
  const calls: FakeCall[] = [];
  let index = 0;
  const create = (params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ params, options });
    const entry = script.responses[index++];
    if (entry === undefined) return Promise.reject(new Error("fake sdk: no scripted response left"));
    if (entry instanceof Error) return Promise.reject(entry);
    if (Array.isArray(entry)) return Promise.resolve(replay(entry, script.delayMs ?? 0));
    return Promise.resolve(entry); // non-stream response object (web search)
  };
  return {
    calls,
    openai: { responses: { create } },
    anthropic: { messages: { create } },
    chat: { chat: { completions: { create } } },
  };
}

/** An SDK-shaped error: `status`, `name`, optional headers. */
export function sdkError(status: number, message: string, name = "APIError", headers?: Record<string, string>): Error {
  return Object.assign(new Error(message), { status, name, headers });
}
