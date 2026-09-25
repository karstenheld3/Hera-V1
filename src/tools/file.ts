// File reading tools: read_file, list_dir, search (HERAV1TOOL-SP01 FR-02, FR-03; HERAV1TOOL-IP01 IS-03). Port of V1
// file_tools.py without the Python fallback: ripgrep is the only search engine (spec 05 DD-08).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { ToolError } from "../errors.ts";
import { EXCLUDED_DIRECTORIES } from "./definitions.ts";
import type { ToolContext, ToolResult } from "./registry.ts";
import { spawn as harnessSpawn } from "../harness/spawn.ts";

export const MAX_LINE_CHARS = 2000;
export const FIND_RESULT_CAP = 50;
export const GREP_LINE_CAP = 200;
export const PATH_HINT_SIBLINGS = 5;
export const SEARCH_TIMEOUT_MS = 60000;
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".ico", ".heic", ".heif"]);

/** Closest existing parent and up to five similar siblings (V1 HERALOGS-PR-0002). */
export function pathNotFoundHint(target: string): string {
  let parent = dirname(target);
  while (parent !== dirname(parent) && !existsSync(parent)) parent = dirname(parent);
  if (!existsSync(parent)) return "";
  const name = basename(target).toLowerCase();
  const stem = name.replace(/\.[^.]*$/, "").replace(/[0-9]+$/, "").replace(/[_\- ]+$/, "");
  let siblings: string[] = [];
  try {
    siblings = readdirSync(parent)
      .filter((s) => s.toLowerCase().includes(name) || (stem.length > 0 && s.toLowerCase().includes(stem)))
      .sort()
      .slice(0, PATH_HINT_SIBLINGS);
  } catch {
    /* unreadable parent */
  }
  let hint = `\n  HINT: closest existing parent is '${parent}'.`;
  if (siblings.length > 0) hint += ` Similar entries: ${siblings.join(", ")}`;
  return hint;
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
}

export function normalizePath(path: string): string {
  return resolve(path).replace(/\\/g, "/").toLowerCase();
}

/** The read ledger shared with the edit gates (spec 05 FR-02): normalized path → stat at the last read or own write. */
export interface LedgerEntry {
  mtimeMs: number;
  size: number;
}

const ledgers = new WeakMap<ToolContext, Map<string, LedgerEntry>>();

export function ledgerOf(ctx: ToolContext): Map<string, LedgerEntry> {
  let ledger = ledgers.get(ctx);
  if (ledger === undefined) {
    ledger = new Map();
    ledgers.set(ctx, ledger);
  }
  return ledger;
}

export function recordRead(ctx: ToolContext, path: string): void {
  const st = statSync(path);
  ledgerOf(ctx).set(normalizePath(path), { mtimeMs: st.mtimeMs, size: st.size });
}

export async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args["file_path"]);
  if (!existsSync(path)) throw new ToolError(`File not found: '${path}'${pathNotFoundHint(path)}`, "Check the path.");
  if (statSync(path).isDirectory()) throw new ToolError(`'${path}' is a directory - use list_dir`, "Pass a file path.");
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) throw new ToolError(`'${basename(path)}' is an image - visual presentation is not available in this CLI environment`, "Describe the image from context or skip it.");
  let text: string;
  try {
    text = decodeText(readFileSync(path));
  } catch (error) {
    throw new ToolError(`Cannot read '${path}': ${error instanceof Error ? error.message : String(error)}`, "Check permissions.");
  }
  recordRead(ctx, path);
  if (text.trim().length === 0) return { status: "ok", text: `<system reminder: '${basename(path)}' exists but has empty contents>` };
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const offset = Math.max(typeof args["offset"] === "number" ? args["offset"] : 1, 1);
  if (offset > lines.length) throw new ToolError(`offset ${offset} is beyond the end of '${basename(path)}' (${lines.length} lines).`, `Use an offset between 1 and ${lines.length}.`);
  const limit = typeof args["limit"] === "number" ? args["limit"] : lines.length;
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const rendered = selected.map((line, i) => {
    const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}... <line truncated>` : line;
    return `${String(offset + i).padStart(6, " ")}\t${shown}`;
  });
  await Promise.resolve();
  return { status: "ok", text: rendered.join("\n") };
}

function countItems(dir: string): number {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      count++;
      const full = join(current, name);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
      } catch {
        /* skip */
      }
    }
  }
  return count;
}

export async function listDir(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  const base = String(args["DirectoryPath"]);
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new ToolError(`Directory not found: '${base}'${pathNotFoundHint(base)}`, "Check the path.");
  const entries = readdirSync(base).map((name) => {
    const full = join(base, name);
    let isDir = false;
    let size = 0;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      size = st.size;
    } catch {
      /* unreadable entry */
    }
    return { name, isDir, size };
  });
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.isDir ? -1 : 1));
  const lines = entries.map((e) => {
    if (e.isDir) {
      const n = countItems(join(base, e.name));
      return `${e.name}/ (${n} item${n === 1 ? "" : "s"})`;
    }
    return `${e.name} (${e.size} bytes)`;
  });
  await Promise.resolve();
  return { status: "ok", text: lines.length === 0 ? `'${base}' is empty.` : lines.join("\n") };
}

// ----------------------------------------------------------------------------------------------------------------- search

export function ripgrepPath(ctx: ToolContext): string {
  const platform = ctx.os?.platform ?? process.platform;
  return join(ctx.appDir, ".agent-tools", platform === "win32" ? "rg.exe" : "rg");
}

function commonFlags(): string[] {
  const flags = ["--color=never", "--hidden", "--no-messages", "--no-ignore"];
  for (const dir of EXCLUDED_DIRECTORIES) flags.push("-g", `!${dir}/`);
  return flags;
}

/** ripgrep argv for content mode (V1 _search_content_rg). */
export function contentArgv(rg: string, query: string, base: string, args: Record<string, unknown>): string[] {
  const cmd = [rg, "--max-filesize=10M", ...commonFlags()];
  cmd.push(args["CaseSensitive"] === true ? "--case-sensitive" : "--smart-case");
  if (args["FixedStrings"] === true) cmd.push("--fixed-strings");
  for (const pattern of (args["Includes"] as string[] | undefined) ?? []) cmd.push("-g", pattern);
  if (typeof args["MaxDepth"] === "number") cmd.push("--max-depth", String(args["MaxDepth"]));
  if (args["MatchPerLine"] === true) cmd.push("--no-heading", "--with-filename", "--line-number", `--max-count=${GREP_LINE_CAP}`);
  else cmd.push("--count");
  cmd.push("--", query, base);
  return cmd;
}

/** ripgrep argv for name mode (V1 _search_name_rg): list files, glob-filter in code. */
export function nameArgv(rg: string, base: string, args: Record<string, unknown>): string[] {
  const cmd = [rg, "--files", "--sort=path", ...commonFlags()];
  if (typeof args["MaxDepth"] === "number") cmd.push("--max-depth", String(args["MaxDepth"]));
  cmd.push(base);
  return cmd;
}

interface RgRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runRipgrep(argv: string[], ctx: ToolContext): Promise<RgRun> {
  const rg = argv[0] as string;
  if (!existsSync(rg)) throw new ToolError(`ripgrep binary not found at '${rg}'.`, "Reinstall Hera or restore .agent-tools/rg.exe next to the configuration; search has no fallback engine.");
  const spawnArgv = ctx.hooks?.mapSearchArgv?.(argv) ?? argv;
  const proc = harnessSpawn(spawnArgv, { kind: "tool", cwd: ctx.workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  ctx.children.register(proc.pid, `search: ${argv.slice(1).join(" ").slice(0, 120)}`);
  const timeoutMs = ctx.timeouts?.searchMs ?? SEARCH_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const onAbort = (): void => proc.kill();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
    if (timedOut) throw new ToolError(`search timed out after ${Math.round(timeoutMs / 1000)} s and ripgrep was killed.`, "Narrow the search path or the pattern.");
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    ctx.children.deregister(proc.pid);
  }
}

function rgFailure(run: RgRun, query: string): ToolError {
  const detail = run.stderr.trim().split(/\r?\n/)[0] ?? "ripgrep exited with code 2";
  const hint = /regex|parse|syntax|unclosed|repetition/i.test(detail) ? " Set FixedStrings=true to search for the literal text instead of treating it as a regex." : "";
  return new ToolError(`search failed for pattern '${query}': ${detail}.${hint}`, "Fix the pattern or the flags.");
}

/** Minimal glob → RegExp for name mode (`*`, `?`, `[...]`, `**`). */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const close = glob.indexOf("]", i);
      if (close > i) {
        out += glob.slice(i, close + 1);
        i = close;
      } else out += "\\[";
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`, "i");
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export async function search(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const base = String(args["SearchPath"]);
  if (!existsSync(base)) throw new ToolError(`Search path not found: '${base}'${pathNotFoundHint(base)}`, "Check the path.");
  const query = String(args["Query"]);
  if (query.trim().length === 0) throw new ToolError("Query is empty. Provide a search pattern (regex for Mode='content', glob for Mode='name').", "Pass a non-empty Query.");
  const mode = (args["Mode"] as string | undefined) ?? "content";
  const rg = ripgrepPath(ctx);
  if (mode === "name") {
    if (!statSync(base).isDirectory()) throw new ToolError(`SearchPath '${base}' is not a directory -> Mode='name' requires a directory. Use Mode='content' to search inside a file, or pass a directory path.`, "Pass a directory.");
    const run = await runRipgrep(nameArgv(rg, base, args), ctx);
    if (run.code > 1) throw rgFailure(run, query);
    const typeFilter = (args["Type"] as string | undefined) ?? "any";
    const matcher = globToRegExp(query);
    const dirs = new Map<string, string>();
    const files: string[] = [];
    for (const line of run.stdout.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const full = line.trim();
      const rel = relative(base, full).replace(/\\/g, "/");
      if (rel.startsWith("..")) continue;
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) {
        const key = parts.slice(0, i).join("/");
        if (!dirs.has(key)) dirs.set(key, join(base, key));
      }
      if (typeFilter !== "directory" && matcher.test(basename(full))) {
        try {
          const st = statSync(full);
          files.push(`${rel} (file, ${st.size} bytes, modified ${formatTime(st.mtimeMs)})`);
        } catch {
          /* vanished */
        }
      }
    }
    const output: string[] = [];
    if (typeFilter !== "file") {
      for (const key of [...dirs.keys()].sort()) {
        if (!matcher.test(basename(key))) continue;
        try {
          output.push(`${key} (dir, modified ${formatTime(statSync(dirs.get(key) as string).mtimeMs)})`);
        } catch {
          /* vanished */
        }
      }
    }
    output.push(...files);
    if (output.length === 0) return { status: "ok", text: "0 matches found." };
    if (output.length > FIND_RESULT_CAP) return { status: "ok", text: [...output.slice(0, FIND_RESULT_CAP), `<capped at ${FIND_RESULT_CAP} results>`].join("\n") };
    return { status: "ok", text: output.join("\n") };
  }
  const run = await runRipgrep(contentArgv(rg, query, base, args), ctx);
  if (run.code > 1) throw rgFailure(run, query);
  if (run.stdout.trim().length === 0) return { status: "ok", text: "No matches found." };
  if (args["MatchPerLine"] === true) {
    const lines = run.stdout.trim().split(/\r?\n/).slice(0, GREP_LINE_CAP);
    const output = lines.map((line) => {
      const m = /^(.*?):(\d+):(.*)$/.exec(line) ?? /^([A-Za-z]:[^:]*?):(\d+):(.*)$/.exec(line);
      const win = /^([A-Za-z]:[\\/][^:]*):(\d+):(.*)$/.exec(line);
      const parts = win ?? m;
      if (parts !== null) return `${parts[1]}:${parts[2]}: ${(parts[3] ?? "").trim().slice(0, 300)}`;
      return line.slice(0, 300);
    });
    if (lines.length >= GREP_LINE_CAP) output.push(`<result truncated at ${GREP_LINE_CAP} lines - narrow the search>`);
    return { status: "ok", text: output.join("\n") };
  }
  const output: string[] = [];
  for (const line of run.stdout.trim().split(/\r?\n/)) {
    const idx = line.lastIndexOf(":");
    if (idx <= 0) continue;
    const count = Number(line.slice(idx + 1).trim());
    if (!Number.isInteger(count)) continue;
    output.push(`${line.slice(0, idx)} (${count} match${count === 1 ? "" : "es"})`);
  }
  return { status: "ok", text: output.length > 0 ? output.join("\n") : "No matches found." };
}
