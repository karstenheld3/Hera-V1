// Shared assertions (HERAV1AGNT-TP01 section 8).

import { readJsonlFile, type AgentEvent } from "../../src/events.ts";

/** Ordered-subsequence match on event types: every entry of `types` appears in order (other events may sit between). */
export function assertEventOrder(events: AgentEvent[], types: string[]): void {
  let cursor = 0;
  for (const event of events) {
    if (cursor < types.length && event.type === types[cursor]) cursor++;
  }
  if (cursor !== types.length) {
    throw new Error(`event order mismatch: expected subsequence [${types.join(", ")}], missing '${types[cursor]}' in [${events.map((e) => e.type).join(", ")}]`);
  }
}

/** Key shapes that must never appear in any output (HERAV1AGNT-SP01 NFR-01). Decoy tokens used by tests share these shapes. */
export const KEY_SHAPES: RegExp[] = [/sk-[A-Za-z0-9_-]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /[A-Za-z0-9]{32}\.[A-Za-z0-9]{16}/, /HERA_DECOY_[A-Za-z0-9]{8,}/];

export function assertNoSecretLeak(outputs: string[], keyShapes: RegExp[] = KEY_SHAPES, extraSecrets: string[] = []): void {
  for (const text of outputs) {
    for (const shape of keyShapes) {
      const match = shape.exec(text);
      if (match) throw new Error(`secret-shaped token leaked (pattern ${shape}): ...${text.slice(Math.max(0, match.index - 30), match.index)}[REDACTED]`);
    }
    for (const secret of extraSecrets) {
      if (secret.length > 0 && text.includes(secret)) throw new Error("secret value leaked into an output (redacted)");
    }
  }
}

export function assertJsonlValid(path: string): AgentEvent[] {
  const result = readJsonlFile(path);
  if (result.warnings.length > 0) throw new Error(`invalid JSONL at ${path}: ${result.warnings.join("; ")}`);
  return result.events;
}
