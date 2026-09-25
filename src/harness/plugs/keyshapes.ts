// Key-shape pattern and redaction (HERAV1LGRD-SP01 FR-04).
// Single owner of the key-shape detection pattern; imported by retry.ts, memory.ts, and localguards.ts.

/** The key-shape pattern: provider key prefixes and long alphanumeric runs. */
export const KEY_SHAPE_PATTERN = /\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{40,})\b/;

/** Returns true if the text contains a key-shaped token. */
export function scanKeyShapes(text: string): boolean {
  return KEY_SHAPE_PATTERN.test(text);
}

/** Removes anything that looks like a key from free text (IG: no key value in logs, events, or errors). */
export function redactKeyShapes(text: string): string {
  return text.replace(/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{40,})\b/g, "***");
}
