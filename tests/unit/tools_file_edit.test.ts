import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolError } from "../../src/errors.ts";
import { applyReplacement, edit, multiEdit, writeToFile } from "../../src/tools/edit.ts";
import { GREP_LINE_CAP, contentArgv, globToRegExp, listDir, nameArgv, readFile, ripgrepPath, search } from "../../src/tools/file.ts";
import { makeTempDir, removeDir } from "../harness/procs.ts";
import { toolCtx } from "../harness/tool_ctx.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function sandbox(): string {
  const root = makeTempDir("tools");
  dirs.push(root);
  mkdirSync(join(root, "src", "deep", "deeper"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, "build"), { recursive: true });
  mkdirSync(join(root, ".tmp_x"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".tmp_x/\n*.log\n");
  writeFileSync(join(root, "README.md"), "# Title\n\nHello World\nhello again\n");
  writeFileSync(join(root, "src", "a.ts"), "export const hello = 1;\nexport const World = 2;\n");
  writeFileSync(join(root, "src", "deep", "b.py"), "print('hello')\n");
  writeFileSync(join(root, "src", "deep", "deeper", "c.txt"), "hello deep\n");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "hello from node_modules\n");
  writeFileSync(join(root, "build", "out.js"), "hello from build\n");
  writeFileSync(join(root, ".tmp_x", "scratch.txt"), "hello from tmp\n");
  writeFileSync(join(root, "notes.log"), "hello from log\n");
  writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}

async function toolError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return (e as Error).message;
  }
  throw new Error("expected a ToolError");
}

describe("HERAV1TOOL-TP01 read_file and list_dir", () => {
  test("HERAV1TOOL-TP01-TC-07 numbered output, offset/limit, 2000-char truncation, image refusal", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    const all = await readFile({ file_path: join(root, "README.md") }, ctx);
    expect(all.text.split("\n")).toEqual(["     1\t# Title", "     2\t", "     3\tHello World", "     4\thello again"]);
    const part = await readFile({ file_path: join(root, "README.md"), offset: 3, limit: 1 }, ctx);
    expect(part.text).toBe("     3\tHello World");
    writeFileSync(join(root, "long.txt"), `${"x".repeat(2500)}\nshort\n`);
    const long = await readFile({ file_path: join(root, "long.txt") }, ctx);
    const first = long.text.split("\n")[0] as string;
    expect(first.endsWith("... <line truncated>")).toBe(true);
    expect(first.length).toBe(7 + 2000 + "... <line truncated>".length);
    expect(await toolError(() => readFile({ file_path: join(root, "image.png") }, ctx))).toContain("is an image");
    writeFileSync(join(root, "empty.txt"), "   \n");
    expect((await readFile({ file_path: join(root, "empty.txt") }, ctx)).text).toContain("exists but has empty contents");
  });

  test("HERAV1TOOL-TP01-TC-08 BOM stripped, invalid bytes replaced, offset beyond length → range error", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    writeFileSync(join(root, "bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first line\n"), Buffer.from([0xff, 0xfe]), Buffer.from(" tail\n")]));
    const r = await readFile({ file_path: join(root, "bom.txt") }, ctx);
    expect(r.text.startsWith("     1\tfirst line")).toBe(true);
    expect(r.text).toContain("\uFFFD");
    expect(await toolError(() => readFile({ file_path: join(root, "README.md"), offset: 99 }, ctx))).toContain("beyond the end");
  });

  test("HERAV1TOOL-TP01-TC-09 hint block with closest parent and siblings; directory passed to read_file → type error", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    const missing = await toolError(() => readFile({ file_path: join(root, "src", "missing", "README.md") }, ctx));
    expect(missing).toContain(`HINT: closest existing parent is '${join(root, "src")}'`);
    const sibling = await toolError(() => readFile({ file_path: join(root, "readme2.md") }, ctx));
    expect(sibling).toContain("Similar entries: README.md");
    expect(await toolError(() => readFile({ file_path: join(root, "src") }, ctx))).toContain("is a directory - use list_dir");
    const listed = await listDir({ DirectoryPath: join(root, "src") }, ctx);
    expect(listed.text.split("\n")).toEqual(["deep/ (3 items)", "a.ts (48 bytes)"]);
    expect(await toolError(() => listDir({ DirectoryPath: join(root, "nope") }, ctx))).toContain("Directory not found");
    mkdirSync(join(root, "emptydir"));
    expect((await listDir({ DirectoryPath: join(root, "emptydir") }, ctx)).text).toContain("is empty");
  });
});

describe("HERAV1TOOL-TP01 search (ripgrep)", () => {
  const rgAvailable = existsSync(ripgrepPath(toolCtx()));

  test("HERAV1TOOL-TP01-TC-10 content mode counts and MatchPerLine lines; flags map to argv", async () => {
    const argv = contentArgv("rg", "hello", "C:/w", { FixedStrings: true, CaseSensitive: true, Includes: ["*.ts", "*.md"], MaxDepth: 2 });
    expect(argv).toContain("--fixed-strings");
    expect(argv).toContain("--case-sensitive");
    expect(argv).not.toContain("--smart-case");
    expect(argv.join(" ")).toContain("-g *.ts -g *.md");
    expect(argv.join(" ")).toContain("--max-depth 2");
    expect(argv.join(" ")).toContain("-g !node_modules/");
    expect(argv.join(" ")).toContain("-g !.agent-data/");
    expect(argv).toContain("--no-ignore");
    expect(argv).toContain("--count");
    const plain = contentArgv("rg", "x", "b", {});
    expect(plain).toContain("--smart-case");
    expect(plain).not.toContain("--fixed-strings");
    expect(nameArgv("rg", "b", { MaxDepth: 3 })).toContain("--files");
    if (!rgAvailable) return;
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    const counts = await search({ Query: "hello", SearchPath: root }, ctx);
    const lines = counts.text.split("\n").sort();
    expect(lines.some((l) => l.endsWith("README.md (2 matches)"))).toBe(true);
    expect(lines.some((l) => l.endsWith("a.ts (1 match)"))).toBe(true);
    expect(lines.some((l) => l.includes("scratch.txt (1 match)"))).toBe(true);
    expect(lines.some((l) => l.includes("notes.log"))).toBe(true);
    expect(lines.some((l) => l.includes("node_modules"))).toBe(false);
    expect(lines.some((l) => l.includes("build"))).toBe(false);
    const perLine = await search({ Query: "Hello World", SearchPath: root, MatchPerLine: true, FixedStrings: true }, ctx);
    expect(perLine.text).toMatch(/README\.md:3: Hello World$/);
    const sensitive = await search({ Query: "Hello", SearchPath: root, CaseSensitive: true, Includes: ["*.md"] }, ctx);
    expect(sensitive.text.trim()).toMatch(/README\.md \(1 match\)$/);
    expect(ctx.children.registered.length).toBeGreaterThan(0);
    expect(ctx.children.live()).toEqual([]);
  });

  test.skipIf(!rgAvailable)("HERAV1TOOL-TP01-TC-11 name mode: Type filter, gitignored found, excluded dirs absent", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    const any = await search({ Query: "*", SearchPath: root, Mode: "name" }, ctx);
    const text = any.text;
    expect(text).toContain(".tmp_x/scratch.txt (file");
    expect(text).toContain(".tmp_x (dir");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("build");
    const files = await search({ Query: "*.ts", SearchPath: root, Mode: "name", Type: "file" }, ctx);
    expect(files.text.trim()).toMatch(/^src\/a\.ts \(file, 48 bytes, modified \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/);
    const dirsOnly = await search({ Query: "deep*", SearchPath: root, Mode: "name", Type: "directory" }, ctx);
    expect(dirsOnly.text.split("\n")).toEqual(expect.arrayContaining([expect.stringMatching(/^src\/deep \(dir/), expect.stringMatching(/^src\/deep\/deeper \(dir/)]));
    expect((await search({ Query: "nothing-here-*", SearchPath: root, Mode: "name" }, ctx)).text).toBe("0 matches found.");
    expect(await toolError(() => search({ Query: "*", SearchPath: join(root, "README.md"), Mode: "name" }, ctx))).toContain("requires a directory");
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a?c").test("abbc")).toBe(false);
  });

  test.skipIf(!rgAvailable)("HERAV1TOOL-TP01-TC-12 invalid regex → error with ripgrep message and FixedStrings hint; zero matches → No matches", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    const message = await toolError(() => search({ Query: "hello(", SearchPath: root }, ctx));
    expect(message).toContain("search failed for pattern 'hello('");
    expect(message).toContain("FixedStrings=true");
    expect((await search({ Query: "zzz_not_present", SearchPath: root }, ctx)).text).toBe("No matches found.");
    expect((await search({ Query: "hello(", SearchPath: root, FixedStrings: true }, ctx)).text).toBe("No matches found.");
    expect(await toolError(() => search({ Query: "  ", SearchPath: root }, ctx))).toContain("Query is empty");
    expect(await toolError(() => search({ Query: "x", SearchPath: join(root, "nope") }, ctx))).toContain("Search path not found");
  });

  test.skipIf(!rgAvailable)("HERAV1TOOL-TP01-TC-13 200-line and 50-result caps with the marker sentence", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    writeFileSync(join(root, "many.txt"), Array.from({ length: 260 }, (_, i) => `needle ${i}`).join("\n"));
    const lines = await search({ Query: "needle", SearchPath: join(root, "many.txt"), MatchPerLine: true }, ctx);
    const out = lines.text.split("\n");
    expect(out).toHaveLength(GREP_LINE_CAP + 1);
    expect(out[GREP_LINE_CAP]).toBe(`<result truncated at ${GREP_LINE_CAP} lines - narrow the search>`);
    mkdirSync(join(root, "lots"));
    for (let i = 0; i < 60; i++) writeFileSync(join(root, "lots", `f${String(i).padStart(2, "0")}.txt`), "x");
    const names = await search({ Query: "f*.txt", SearchPath: join(root, "lots"), Mode: "name" }, ctx);
    const nameLines = names.text.split("\n");
    expect(nameLines).toHaveLength(51);
    expect(nameLines[50]).toBe("<capped at 50 results>");
  });

  test("HERAV1TOOL-TP01-TC-14 missing binary → error with path and action; stub rg sleeping → killed at the injected timeout", async () => {
    const root = sandbox();
    const noBinary = toolCtx({ workspace: root, appDir: join(root, "no-app") });
    const message = await toolError(() => search({ Query: "x", SearchPath: root }, noBinary));
    expect(message).toContain(join(root, "no-app", ".agent-tools"));
    expect(message).toContain("no fallback engine");
    // a stub rg.exe that exists (copy of the runtime) while the spawn hook redirects argv to a sleeping script:
    // the real spawn, register, timeout, kill, and deregister path runs against a hanging child
    const appDir = join(root, "stub-app");
    mkdirSync(join(appDir, ".agent-tools"), { recursive: true });
    const stubPath = ripgrepPath(toolCtx({ appDir }));
    copyFileSync(process.execPath, stubPath);
    writeFileSync(join(appDir, "sleep.ts"), "await Bun.sleep(30000);\n");
    const ctx = toolCtx({ workspace: root, appDir, timeouts: { searchMs: 1500 } });
    ctx.hooks = { mapSearchArgv: () => [process.execPath, join(appDir, "sleep.ts")] };
    const started = performance.now();
    const slow = await toolError(() => search({ Query: "x", SearchPath: root }, ctx));
    expect(slow).toContain("search timed out after 2 s");
    expect(performance.now() - started).toBeLessThan(10000);
    expect(ctx.children.registered).toHaveLength(1);
    expect(ctx.children.live()).toEqual([]);
  });
});
describe("HERAV1TOOL-TP01 edit gates", () => {
  test("HERAV1TOOL-TP01-TC-15 read → edit applied and ledger updated; edit without read → not read", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    const file = join(root, "src", "a.ts");
    expect(await toolError(() => edit({ file_path: file, old_string: "hello", new_string: "hi" }, ctx))).toContain("was not read in this session");
    await readFile({ file_path: file }, ctx);
    const r = await edit({ file_path: file, old_string: "hello = 1", new_string: "hello = 42" }, ctx);
    expect(r.text).toBe(`Edit applied to '${file}'.`);
    expect(readFileSync(file, "utf8")).toBe("export const hello = 42;\nexport const World = 2;\n");
    // the own write updated the ledger: a second edit passes without re-reading
    await edit({ file_path: file, old_string: "World = 2", new_string: "World = 3" }, ctx);
    expect(readFileSync(file, "utf8")).toContain("World = 3");
    expect(await toolError(() => edit({ file_path: join(root, "nope.ts"), old_string: "a", new_string: "b" }, ctx))).toContain("File not found");
  });

  test("HERAV1TOOL-TP01-TC-16 external modification → 'modified since read'; own chain of three edits passes", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    const file = join(root, "README.md");
    await readFile({ file_path: file }, ctx);
    writeFileSync(file, "# Title\n\nHello World\nhello again\nEXTERNAL\n");
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    expect(await toolError(() => edit({ file_path: file, old_string: "Title", new_string: "T" }, ctx))).toContain("modified externally after the last read");
    await readFile({ file_path: file }, ctx);
    for (const [o, n] of [
      ["Title", "T1"],
      ["Hello World", "HW"],
      ["EXTERNAL", "E"],
    ]) {
      await edit({ file_path: file, old_string: o as string, new_string: n as string }, ctx);
    }
    expect(readFileSync(file, "utf8")).toBe("# T1\n\nHW\nhello again\nE\n");
  });

  test("HERAV1TOOL-TP01-TC-17 uniqueness, replace_all, old === new", () => {
    expect(() => applyReplacement("a b a", "a", "c", false, "f")).toThrow(/occurs 2 times/);
    expect(applyReplacement("a b a", "a", "c", true, "f")).toBe("c b c");
    expect(() => applyReplacement("a", "a", "a", false, "f")).toThrow(/identical/);
    expect(() => applyReplacement("a", "z", "y", false, "f")).toThrow(/not found/);
    expect(applyReplacement("price $1", "$1", "$2", false, "f")).toBe("price $2");
  });

  test("HERAV1TOOL-TP01-TC-18 failing third edit → file bytes unchanged", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    const file = join(root, "src", "a.ts");
    const before = readFileSync(file);
    await readFile({ file_path: file }, ctx);
    const message = await toolError(() =>
      multiEdit(
        {
          file_path: file,
          edits: [
            { old_string: "hello", new_string: "h1" },
            { old_string: "World", new_string: "W1" },
            { old_string: "missing", new_string: "m" },
          ],
        },
        ctx,
      ),
    );
    expect(message).toContain("multi_edit failed at edit 3 of 3; no changes were applied.");
    expect(readFileSync(file).equals(before)).toBe(true);
    const ok = await multiEdit({ file_path: file, edits: [{ old_string: "hello", new_string: "h1" }, { old_string: "World", new_string: "W1" }] }, ctx);
    expect(ok.text).toBe(`2 edits applied to '${file}'.`);
    expect(readFileSync(file, "utf8")).toBe("export const h1 = 1;\nexport const W1 = 2;\n");
  });

  test("HERAV1TOOL-TP01-TC-19 write_to_file: existing target error, parents created, EmptyFile, traversal rejected", async () => {
    const root = sandbox();
    const ctx = toolCtx({ workspace: root });
    expect(await toolError(() => writeToFile({ TargetFile: join(root, "README.md"), CodeContent: "x", EmptyFile: false }, ctx))).toContain("already exists");
    const target = join(root, "new", "nested", "file.txt");
    const r = await writeToFile({ TargetFile: target, CodeContent: "content\n", EmptyFile: false }, ctx);
    expect(r.text).toBe(`Created '${target}' (8 chars).`);
    expect(readFileSync(target, "utf8")).toBe("content\n");
    // the new file counts as read: an edit follows without read_file
    await edit({ file_path: target, old_string: "content", new_string: "changed" }, ctx);
    const empty = join(root, "new", "empty.txt");
    await writeToFile({ TargetFile: empty, CodeContent: "ignored", EmptyFile: true }, ctx);
    expect(readFileSync(empty, "utf8")).toBe("");
    expect(await toolError(() => writeToFile({ TargetFile: `${root}/new/../escape.txt`, CodeContent: "x", EmptyFile: false }, ctx))).toContain("'..' path traversal");
    expect(await toolError(() => writeToFile({ TargetFile: "relative.txt", CodeContent: "x", EmptyFile: false }, ctx))).toContain("must be an absolute path");
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
  });
});
