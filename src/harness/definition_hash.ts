// Definition hash - one fold over session_started payload + binary version + plug_hash
// (HERAV1HRNS-SP01 FR-09; HERAV1HRNS-IP01 IS-18).
// Replaces the legacy prompt system hash module (three separate hashes → one definition_hash).

import { readFileSync } from "node:fs";
import { BINARY_VERSION } from "../version.ts";
import type { PromptSystem } from "../prompt/loader.ts";
import type { ToolDefinition } from "../models.ts";

/** Content hash of the prompt system files (stable across loads, changes on any byte). */
export function promptSystemContentHash(system: PromptSystem): string {
  const parts = [
    ...system.rules.map((r) => `rule:${r.filename}:${r.skippedReason ?? ""}:${r.content}`),
    ...system.workflows.map((w) => `workflow:${w.name}:${w.content}`),
    ...system.skills.map((s) => `skill:${s.name}:${s.content}:${s.supportingFiles.join(",")}`),
  ].sort();
  return new Bun.CryptoHasher("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

export interface DefinitionHashInput {
  promptSystemHash: string;
  toolDefinitions: readonly ToolDefinition[];
  configSnapshot: Record<string, unknown>;
  modelRefs: Record<string, string>;
  plugHash: string;
}

/** One fold over the session_started payload + binary version + plug_hash. */
export function computeDefinitionHash(input: DefinitionHashInput): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input.promptSystemHash);
  hasher.update("\x00");
  hasher.update(JSON.stringify(input.toolDefinitions.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))));
  hasher.update("\x00");
  hasher.update(JSON.stringify(input.configSnapshot));
  hasher.update("\x00");
  hasher.update(JSON.stringify(input.modelRefs));
  hasher.update("\x00");
  hasher.update(BINARY_VERSION);
  hasher.update("\x00");
  hasher.update(input.plugHash);
  return hasher.digest("hex").slice(0, 32);
}

/** model_ref exact match - rejects gpt-5.1 for gpt-5.1-2026-12. */
export function modelRefMatch(recorded: string, current: string): boolean {
  return recorded === current;
}

/** SHA-256 content hash of a file (helper executable integrity check). */
export function fileContentHash(filePath: string): string {
  const data = readFileSync(filePath);
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** Verify a helper executable by content hash; true if match, false if mismatch. */
export function verifyHelperExecutable(embeddedPath: string, existingPath: string): boolean {
  return fileContentHash(embeddedPath) === fileContentHash(existingPath);
}
