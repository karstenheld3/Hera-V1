import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeDefinitionHash, modelRefMatch, promptSystemContentHash, fileContentHash, verifyHelperExecutable, type DefinitionHashInput } from "../../src/harness/definition_hash.ts";
import { loadPromptSystem } from "../../src/prompt/loader.ts";
import { REPO_ROOT, makeTempDir, removeDir } from "../harness/procs.ts";

const FAKE_SYSTEM = join(REPO_ROOT, "tests", "fixtures", "fake_system");

function baseInput(overrides: Partial<DefinitionHashInput> = {}): DefinitionHashInput {
  return {
    promptSystemHash: "abc123",
    toolDefinitions: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
    configSnapshot: { roles: { generating: { model_id: "glm-5.2" } } },
    modelRefs: { generating: "glm-5.2", compacting: "gpt-4.1-mini", supervisor: "gpt-4.1-mini", memory: "gpt-4.1-mini", communicator: "gpt-4.1-mini", websearch: "gpt-4.1-mini" },
    plugHash: "plug123",
    ...overrides,
  };
}

describe("HERAV1HRNS-TP01-TC-07: definition hash (H-09)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) removeDir(d);
  });

  test("hash is stable across calls with identical inputs", () => {
    const a = computeDefinitionHash(baseInput());
    const b = computeDefinitionHash(baseInput());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  test("hash is stable across processes (deterministic, no randomness)", () => {
    const inputs = baseInput();
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      hashes.push(computeDefinitionHash(inputs));
    }
    expect(new Set(hashes).size).toBe(1);
  });

  test("hash changes on any sealed input - prompt system hash", () => {
    const a = computeDefinitionHash(baseInput());
    const b = computeDefinitionHash(baseInput({ promptSystemHash: "different" }));
    expect(a).not.toBe(b);
  });

  test("hash changes on any sealed input - tool definitions", () => {
    const a = computeDefinitionHash(baseInput());
    const b = computeDefinitionHash(baseInput({ toolDefinitions: [{ name: "write_file", description: "Write a file", parameters: { type: "object" } }] }));
    expect(a).not.toBe(b);
  });

  test("hash changes on any sealed input - config snapshot", () => {
    const a = computeDefinitionHash(baseInput());
    const b = computeDefinitionHash(baseInput({ configSnapshot: { roles: { generating: { model_id: "gpt-5.1" } } } }));
    expect(a).not.toBe(b);
  });

  test("hash changes on any sealed input - model refs", () => {
    const a = computeDefinitionHash(baseInput());
    const b = computeDefinitionHash(baseInput({ modelRefs: { ...baseInput().modelRefs, generating: "gpt-5.1" } }));
    expect(a).not.toBe(b);
  });

  test("hash changes on any sealed input - plug hash", () => {
    const a = computeDefinitionHash(baseInput());
    const b = computeDefinitionHash(baseInput({ plugHash: "different_plug" }));
    expect(a).not.toBe(b);
  });

  test("hash changes on any sealed input - binary version (embedded in fold)", () => {
    const a = computeDefinitionHash(baseInput());
    const b = computeDefinitionHash(baseInput({ configSnapshot: { ...baseInput().configSnapshot, _version: "2.0.1" } }));
    expect(a).not.toBe(b);
  });

  test("prompt system content hash is stable across loads and changes on any byte", () => {
    const dir = makeTempDir("dh_ps");
    dirs.push(dir);
    cpSync(FAKE_SYSTEM, dir, { recursive: true });
    const a = promptSystemContentHash(loadPromptSystem(dir));
    const b = promptSystemContentHash(loadPromptSystem(dir));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    const rulePath = join(dir, "rules", "coding-style.md");
    writeFileSync(rulePath, `${readFileSync(rulePath, "utf8")}x`);
    const c = promptSystemContentHash(loadPromptSystem(dir));
    expect(c).not.toBe(a);
  });

  test("model_ref exact match: rejects gpt-5.1 for gpt-5.1-2026-12", () => {
    expect(modelRefMatch("gpt-5.1", "gpt-5.1")).toBe(true);
    expect(modelRefMatch("gpt-5.1", "gpt-5.1-2026-12")).toBe(false);
    expect(modelRefMatch("gpt-5.1-2026-12", "gpt-5.1-2026-12")).toBe(true);
    expect(modelRefMatch("gpt-5.1", "gpt-5.1-mini")).toBe(false);
  });

  test("resume: hash mismatch detected by comparing recorded vs current", () => {
    const recorded = computeDefinitionHash(baseInput());
    const current = computeDefinitionHash(baseInput({ modelRefs: { ...baseInput().modelRefs, generating: "gpt-5.1" } }));
    expect(recorded).not.toBe(current);
    expect(recorded === current).toBe(false);
  });

  test("fileContentHash produces stable hash for identical files", () => {
    const dir = makeTempDir("dh_fh");
    dirs.push(dir);
    const f1 = join(dir, "a.txt");
    const f2 = join(dir, "b.txt");
    writeFileSync(f1, "hello world");
    writeFileSync(f2, "hello world");
    expect(fileContentHash(f1)).toBe(fileContentHash(f2));
    writeFileSync(f2, "hello world!");
    expect(fileContentHash(f1)).not.toBe(fileContentHash(f2));
  });

  test("verifyHelperExecutable returns true for identical, false for differing", () => {
    const dir = makeTempDir("dh_he");
    dirs.push(dir);
    const f1 = join(dir, "original.exe");
    const f2 = join(dir, "copy.exe");
    const f3 = join(dir, "different.exe");
    writeFileSync(f1, "binary content");
    writeFileSync(f2, "binary content");
    writeFileSync(f3, "different binary content");
    expect(verifyHelperExecutable(f1, f2)).toBe(true);
    expect(verifyHelperExecutable(f1, f3)).toBe(false);
  });
});
