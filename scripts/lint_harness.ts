#!/usr/bin/env bun
/**
 * Harness lint (HERAV1HRNS-IP01 IS-06, IS-21): enforces that Bun.spawn, fetch(),
 * SDK client construction, adapter factory calls, eval(), and dynamic import()
 * do not occur outside src/harness/ and src/providers/.
 *
 * A line outside the allowed folders is permitted only when it carries an inline
 * marker naming the pattern it legitimately matches: `// harness-allow: <unit> <pattern-name>`.
 * Two violation kinds:
 * 1. Unmarked: a line matches a pattern and carries no marker naming that pattern.
 * 2. Stale marker: a line carries a marker whose pattern name is unknown or does
 *    not match the line it sits on.
 *
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

const MARKER_REGEX = /\/\/\s*harness-allow:\s*(\S+)\s+(.+?)\s*$/;

interface Hit {
  file: string;
  line: number;
  text: string;
  pattern: string;
  kind: "unmarked" | "stale-marker";
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

function scanFile(filePath: string, inAllowedFolder: boolean): Hit[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relFile = relative(SRC_ROOT, filePath).replace(/\\/g, "/");
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }

    // Stale-marker pass: every marker must name a known pattern that matches its own line.
    const markerMatch = MARKER_REGEX.exec(line);
    if (markerMatch !== null) {
      const patternName = markerMatch[2];
      const pattern = PATTERNS.find((p) => p.name === patternName);
      if (pattern === undefined || !pattern.regex.test(line)) {
        hits.push({ file: relFile, line: i + 1, text: trimmed.length > 120 ? trimmed.substring(0, 117) + "..." : trimmed, pattern: patternName, kind: "stale-marker" });
      }
    }

    // Unmarked pass: only outside the allowed folders.
    if (inAllowedFolder) continue;
    for (const pat of PATTERNS) {
      if (!pat.regex.test(line)) continue;
      if (markerMatch !== null && markerMatch[2] === pat.name) continue;
      hits.push({ file: relFile, line: i + 1, text: trimmed.length > 120 ? trimmed.substring(0, 117) + "..." : trimmed, pattern: pat.name, kind: "unmarked" });
    }
  }

  return hits;
}

function main(): void {
  const files = listTsFiles(SRC_ROOT).sort();
  const violations: Hit[] = [];

  for (const file of files) {
    const relPath = relative(SRC_ROOT, file).replace(/\\/g, "/");
    const firstPart = relPath.split("/")[0] ?? "";
    const inAllowedFolder = ALLOWED_FOLDERS.includes(firstPart);
    violations.push(...scanFile(file, inAllowedFolder));
  }

  if (violations.length > 0) {
    const unmarked = violations.filter((v) => v.kind === "unmarked").length;
    const stale = violations.filter((v) => v.kind === "stale-marker").length;
    console.error(`lint:harness: ${violations.length} violation(s) found (${unmarked} unmarked, ${stale} stale marker):`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.pattern}] (${v.kind})  ${v.text}`);
    }
    process.exit(1);
  }

  console.log(`lint:harness: 0 violations (scanned ${files.length} files)`);
}

main();