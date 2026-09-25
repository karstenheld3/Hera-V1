// Edit tools with the read gate: edit, multi_edit, write_to_file (HERAV1TOOL-SP01 FR-02; HERAV1TOOL-IP01 IS-04).
// Port of V1 edit_tools.py. Writes go to a temp file in the same directory and are renamed into place (atomic per file).

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ToolError } from "../errors.ts";
import { decodeText, ledgerOf, normalizePath, recordRead } from "./file.ts";
import type { ToolContext, ToolResult } from "./registry.ts";

/** The read gate: the file was read in this Executor lifetime and is unmodified since (spec 05 FR-02). */
export function assertReadFresh(path: string, ctx: ToolContext): void {
  const entry = ledgerOf(ctx).get(normalizePath(path));
  if (entry === undefined) throw new ToolError(`Cannot edit '${path}': the file was not read in this session. Read it with read_file first (edit gate).`, "Call read_file on the file, then edit.");
  const st = statSync(path);
  if (st.mtimeMs > entry.mtimeMs + 0.5 || st.size !== entry.size) throw new ToolError(`Cannot edit '${path}': the file was modified externally after the last read. Re-read it with read_file first (edit gate).`, "Call read_file again, then edit.");
}

export function applyReplacement(text: string, oldString: string, newString: string, replaceAll: boolean, path: string): string {
  if (oldString === newString) throw new ToolError(`Edit rejected for '${path}': old_string and new_string are identical (no-op).`, "Change new_string.");
  if (oldString.length === 0) throw new ToolError(`Edit rejected for '${path}': old_string is empty.`, "Provide the text to replace.");
  const occurrences = text.split(oldString).length - 1;
  if (occurrences === 0) throw new ToolError(`Edit failed for '${path}': old_string not found in file.`, "Read the file and copy the exact text.");
  if (occurrences > 1 && !replaceAll) throw new ToolError(`Edit failed for '${path}': old_string occurs ${occurrences} times. Provide more context to make it unique or set replace_all.`, "Extend old_string or set replace_all.");
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
}

/** Write via a sibling temp file and rename so a crash never leaves a half-written target. */
export function atomicWrite(path: string, content: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function readCurrent(path: string): string {
  if (!existsSync(path)) throw new ToolError(`File not found: '${path}'`, "Check the path; use write_to_file for new files.");
  if (statSync(path).isDirectory()) throw new ToolError(`'${path}' is a directory.`, "Pass a file path.");
  return decodeText(readFileSync(path));
}

export async function edit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args["file_path"]);
  const text = readCurrent(path);
  assertReadFresh(path, ctx);
  const updated = applyReplacement(text, String(args["old_string"]), String(args["new_string"]), args["replace_all"] === true, path);
  atomicWrite(path, updated);
  recordRead(ctx, path);
  await Promise.resolve();
  return { status: "ok", text: `Edit applied to '${path}'.` };
}

export async function multiEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = String(args["file_path"]);
  const text = readCurrent(path);
  assertReadFresh(path, ctx);
  const edits = args["edits"] as Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
  let updated = text;
  for (const [index, item] of edits.entries()) {
    try {
      updated = applyReplacement(updated, item.old_string, item.new_string, item.replace_all === true, path);
    } catch (error) {
      throw new ToolError(`multi_edit failed at edit ${index + 1} of ${edits.length}; no changes were applied. ${error instanceof Error ? error.message : String(error)}`, "Fix the failing edit and resend all edits.");
    }
  }
  atomicWrite(path, updated);
  recordRead(ctx, path);
  await Promise.resolve();
  return { status: "ok", text: `${edits.length} edit${edits.length === 1 ? "" : "s"} applied to '${path}'.` };
}

export async function writeToFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const raw = String(args["TargetFile"]);
  if (!isAbsolute(raw)) throw new ToolError(`TargetFile '${raw}' must be an absolute path.`, "Pass the full path.");
  if (raw.split(/[\\/]/).includes("..")) throw new ToolError(`TargetFile '${raw}' contains '..' path traversal.`, "Pass a normalized absolute path.");
  const path = resolve(raw);
  if (existsSync(path)) throw new ToolError(`Cannot create '${path}': the file already exists. Use edit or multi_edit to modify existing files.`, "Edit the existing file instead.");
  mkdirSync(dirname(path), { recursive: true });
  const content = args["EmptyFile"] === true ? "" : String(args["CodeContent"]);
  atomicWrite(path, content);
  recordRead(ctx, path);
  await Promise.resolve();
  return { status: "ok", text: `Created '${path}' (${content.length} chars).` };
}
