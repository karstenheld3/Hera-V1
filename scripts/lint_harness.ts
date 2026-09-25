#!/usr/bin/env bun
/**
 * Harness lint (HERAV1HRNS-IP01 IS-06, IS-21): enforces that Bun.spawn, fetch(),
 * SDK client construction, adapter factory calls, eval(), and dynamic import()
 * do not occur outside src/harness/ and src/providers/.
 *
 * Known bypass sites owned by other units are allow-listed with a comment.
 * Reads files only. Never spawns, fetches, or imports product modules.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "src");
const ALLOWED_FOLDERS = ["harness", "providers"];

interface Pattern {
  name: string;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: "Bun.spawn", regex: /\bBun\.spawn\b/ },
  { name: "fetch()", regex: /\bfetch\s*\(/ },
  { name: "new OpenAI()", regex: /\bnew\s+OpenAI\s*\(/ },
  { name: "new Anthropic()", regex: /\bnew\s+Anthropic\s*\(/ },
  { name: "getAdapter()", regex: /\bgetAdapter\s*\(/ },
  { name: "adapterForRole()", regex: /\badapterForRole\s*\(/ },
  { name: "streamTurn()", regex: /\.streamTurn\s*\(/ },
  { name: "spawnChild()", regex: /\bspawnChild\s*\(/ },
  { name: "dynamic import (provider)", regex: /\bawait\s+import\s*\(\s*["']\.\/(?:openai|anthropic|zai)/ },
  { name: "dynamic import SDK (openai)", regex: /await\s+import\s*\(\s*["']openai["']/ },
  { name: "dynamic import SDK (anthropic)", regex: /await\s+import\s*\(\s*["']@anthropic-ai\/sdk["']/ },
  { name: "eval()", regex: /\beval\s*\(/ },
];

interface AllowEntry {
  file: string;
  line: number;
  pattern: string;
  unit: string;
}

const ALLOW_LIST: AllowEntry[] = [
  // U12: process/bootstrap.ts - spawnChild definition (calls the spawn wrapper, not Bun.spawn directly)
  { file: "process/bootstrap.ts", line: 30, pattern: "spawnChild()", unit: "U12" },
  // U12: selftest - selftest runner and categories
  { file: "selftest/categories/07_process_health.ts", line: 60, pattern: "spawnChild()", unit: "U12" },
  { file: "selftest/categories/02_configuration.ts", line: 48, pattern: "getAdapter()", unit: "U12" },
  { file: "selftest/runner.ts", line: 312, pattern: "getAdapter()", unit: "U12" },
  // U7: tools/web.ts - fetch() wrapped through gate as net.egress
  { file: "tools/web.ts", line: 100, pattern: "fetch()", unit: "U7" },
  { file: "tools/web.ts", line: 109, pattern: "fetch()", unit: "U7" },
  // U7: executor/main.ts - adapter construction for the Executor process
  { file: "executor/main.ts", line: 72, pattern: "getAdapter()", unit: "U7" },
  { file: "executor/main.ts", line: 73, pattern: "getAdapter()", unit: "U7" },
  { file: "executor/main.ts", line: 74, pattern: "getAdapter()", unit: "U7" },
  // U7: supervisor/core.ts - adapter construction for the Supervisor process
  { file: "supervisor/core.ts", line: 257, pattern: "getAdapter()", unit: "U7" },
  // U7: supervisor/memory.ts - fallback streamTurn when gate is undefined
  { file: "supervisor/memory.ts", line: 352, pattern: "streamTurn()", unit: "U7" },
  // U7: cli/builtins.ts - communicator ask adapter
  { file: "cli/builtins.ts", line: 82, pattern: "getAdapter()", unit: "U7" },
  { file: "cli/builtins.ts", line: 92, pattern: "streamTurn()", unit: "U7" },
]

interface Hit {
  file: string;
  line: number;
  text: string;
  pattern: string;
}

function listTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

function isAllowed(file: string, line: number, pattern: string): boolean {
  return ALLOW_LIST.some(
    (a) => a.file === file && a.line === line && a.pattern === pattern,
  );
}

function scanFile(filePath: string): Hit[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    for (const pat of PATTERNS) {
      if (pat.regex.test(line)) {
        hits.push({
          file: relative(SRC_ROOT, filePath).replace(/\\/g, "/"),
          line: i + 1,
          text: trimmed.length > 120 ? trimmed.substring(0, 117) + "..." : trimmed,
          pattern: pat.name,
        });
      }
    }
  }

  return hits;
}

function main(): void {
  const files = listTsFiles(SRC_ROOT).sort();
  const violations: Hit[] = [];

  for (const file of files) {
    const relPath = relative(SRC_ROOT, file).replace(/\\/g, "/");
    const parts = relPath.split("/");
    const firstPart = parts[0] ?? "";

    const inAllowedFolder = ALLOWED_FOLDERS.includes(firstPart);

    const hits = scanFile(file);
    for (const hit of hits) {
      if (inAllowedFolder) continue;
      if (isAllowed(hit.file, hit.line, hit.pattern)) continue;
      violations.push(hit);
    }
  }

  if (violations.length > 0) {
    console.error(`lint:harness: ${violations.length} violation(s) found outside src/harness/ and src/providers/:`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.pattern}]  ${v.text}`);
    }
    process.exit(1);
  }

  console.log(`lint:harness: 0 violations (scanned ${files.length} files)`);
}

main();
