// PromptQueueFile parser (HERAV1CLI-SP01 FR-05, section 3; HERAV1CLI-IP01 IS-02). Port of V1 prompt_queue.py.
// Six format rules; every violation names its rule so the user fixes the file, exit code 2, no child spawned.

import { ConfigError } from "../errors.ts";
import { nowTs, type AgentEvent } from "../events.ts";

export type QueueRule = "first_line_fence" | "fence_length" | "unclosed_fence" | "missing_separator" | "zero_prompts" | "content_after_close";

export class QueueError extends ConfigError {
  readonly rule: QueueRule;
  constructor(rule: QueueRule, message: string, line: number | undefined) {
    super(`prompt file rule '${rule}' violated${line !== undefined ? ` at line ${line}` : ""}: ${message}`, "Fix the prompt file: fenced prompts (3-9 backticks), separated by a '---' line, commentary only between '---' and the next fence.");
    this.rule = rule;
  }
}

const FENCE = /^(`{3,})(.*)$/;

/** Returns the prompts in fence order (each without its fences, trailing newline trimmed). */
export function parsePromptQueueFile(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const prompts: string[] = [];
  let i = 0;
  while (i < lines.length && (lines[i] as string).trim().length === 0) i++;
  if (i >= lines.length) throw new QueueError("zero_prompts", "the file contains no fenced prompt.", undefined);
  if (!FENCE.test((lines[i] as string).trim())) throw new QueueError("first_line_fence", `the first non-empty line must be an opening fence, found '${(lines[i] as string).slice(0, 40)}'.`, i + 1);
  let expectFence = true;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (expectFence) {
      const m = FENCE.exec(line.trim());
      if (m === null) {
        if (line.trim().length === 0) {
          i++;
          continue;
        }
        throw new QueueError("first_line_fence", `expected an opening fence, found '${line.slice(0, 40)}'.`, i + 1);
      }
      const n = (m[1] as string).length;
      if (n > 9) throw new QueueError("fence_length", `opening fence of ${n} backticks; the maximum is 9.`, i + 1);
      const body: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const candidate = lines[i] as string;
        const close = /^(`{3,})\s*$/.exec(candidate.trim());
        if (close !== null && (close[1] as string).length >= n) {
          closed = true;
          i++;
          break;
        }
        body.push(candidate);
        i++;
      }
      if (!closed) throw new QueueError("unclosed_fence", `the fence opened with ${n} backticks is never closed.`, i);
      prompts.push(body.join("\n").replace(/\s+$/, ""));
      expectFence = false;
      continue;
    }
    // between prompts: blank lines, then exactly one '---', then optional commentary, then the next fence
    if (line.trim().length === 0) {
      i++;
      continue;
    }
    if (line.trim() !== "---") {
      if (FENCE.test(line.trim())) throw new QueueError("missing_separator", "a new fence follows a prompt without a '---' separator line.", i + 1);
      throw new QueueError("content_after_close", `content after a closing fence must start with a '---' line, found '${line.slice(0, 40)}'.`, i + 1);
    }
    i++;
    // commentary until the next fence (never sent)
    while (i < lines.length && !FENCE.test((lines[i] as string).trim())) {
      if ((lines[i] as string).trim() === "---") throw new QueueError("missing_separator", "two '---' separators without a prompt between them.", i + 1);
      i++;
    }
    if (i >= lines.length) throw new QueueError("missing_separator", "a '---' separator is not followed by another prompt.", i);
    expectFence = true;
  }
  if (prompts.length === 0) throw new QueueError("zero_prompts", "the file contains no fenced prompt.", undefined);
  return prompts;
}

export function digest(prompt: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(prompt);
  return hasher.digest("hex").slice(0, 12);
}

export function promptStepEvent(index: number, total: number, prompt: string): AgentEvent {
  return { ts: nowTs(), proc: "comm", type: "prompt_step", index, total, digest: digest(prompt) };
}
