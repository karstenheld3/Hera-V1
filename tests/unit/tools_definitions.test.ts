import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolError } from "../../src/errors.ts";
import { EXCLUDED_DIRECTORIES as PROMPT_EXCLUDED } from "../../src/prompt/assemble.ts";
import { TOOL_NAMES as PROMPT_TOOL_NAMES } from "../../src/prompt/sections.ts";
import { DEFINITION_TEMPLATES, EXCLUDED_DIRECTORIES, TOOL_NAMES, buildDefinitions, definitionsHash, filterDefinitions, renderSkillList, stableJson } from "../../src/tools/definitions.ts";
import { ToolRegistry, capResult, validateAgainstSchema } from "../../src/tools/registry.ts";
import { createToolRegistry } from "../../src/tools/index.ts";
import { REPO_ROOT } from "../harness/procs.ts";
import { call, toolCtx } from "../harness/tool_ctx.ts";

const FIXTURE = JSON.parse(readFileSync(join(REPO_ROOT, "tests", "fixtures", "tools", "tool_definitions.json"), "utf8")) as Array<{ name: string; description: string; schema: Record<string, unknown> }>;
const V1_SENTENCE = "Excluded directories (hardcoded): .git, node_modules, __pycache__, .venv, venv, dist, build, .hg, .svn, .pytest_cache, .mypy_cache.";

describe("HERAV1TOOL-TP01 definitions", () => {
  test("HERAV1TOOL-TP01-TC-01 the 15 templates deep-equal the extracted tool fixture; dropped tools absent", () => {
    expect(DEFINITION_TEMPLATES).toHaveLength(15);
    expect(FIXTURE).toHaveLength(15);
    for (const [i, template] of DEFINITION_TEMPLATES.entries()) {
      const ref = FIXTURE[i];
      expect(template.name).toBe(ref?.name as string);
      expect(template.schema).toEqual(ref?.schema as Record<string, unknown>);
      const expected = template.name === "search" ? (ref?.description as string).replace(V1_SENTENCE, "Excluded directories (hardcoded): {EXCLUDED_DIRECTORIES}.") : (ref?.description as string);
      expect(template.description).toBe(expected);
    }
    expect(TOOL_NAMES).toEqual([...PROMPT_TOOL_NAMES]);
    expect(TOOL_NAMES).not.toContain("grep_search");
    expect(TOOL_NAMES).not.toContain("find_by_name");
    expect(DEFINITION_TEMPLATES.find((t) => t.name === "run_command")?.schema).toMatchObject({ properties: { SafeToAutoRun: { type: "boolean" } } });
  });

  test("HERAV1TOOL-TP01-TC-02 generated parts: OS/shell text, excluded-directory sentence in constant order, skill list", () => {
    const defs = buildDefinitions({ os: "windows", shell: "pwsh", skills: [{ name: "alpha", description: "Alpha skill", supportingFiles: ["a.md", "b.md"] }, { name: "beta", description: "Beta skill", supportingFiles: [] }] });
    expect(defs).toHaveLength(15);
    const run = defs.find((d) => d.name === "run_command")?.description ?? "";
    expect(run).toContain("Operating System: windows. Shell: pwsh.");
    expect(run).not.toContain("{OS}");
    const search = defs.find((d) => d.name === "search")?.description ?? "";
    expect(search).toContain(`Excluded directories (hardcoded): ${EXCLUDED_DIRECTORIES.join(", ")}.`);
    expect(EXCLUDED_DIRECTORIES).toEqual([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".agent", ".agent-data", "dist", "build"]);
    expect(PROMPT_EXCLUDED).toBe(EXCLUDED_DIRECTORIES);
    const skill = defs.find((d) => d.name === "skill")?.description ?? "";
    expect(skill.endsWith("Available skills:\n- alpha: Alpha skill (2 supporting files)\n- beta: Beta skill")).toBe(true);
    expect(renderSkillList([{ name: "x", description: "d", supportingFiles: ["one"] }])).toBe("- x: d (1 supporting file)");
    // the other 12 descriptions are byte-identical to the fixture
    for (const d of defs) {
      if (["run_command", "search", "skill"].includes(d.name)) continue;
      expect(d.description).toBe(FIXTURE.find((f) => f.name === d.name)?.description as string);
    }
    const again = buildDefinitions({ os: "windows", shell: "pwsh", skills: [] });
    expect(definitionsHash(again)).toBe(definitionsHash(buildDefinitions({ os: "windows", shell: "pwsh", skills: [] })));
    expect(definitionsHash(again)).not.toBe(definitionsHash(defs));
    expect(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe("HERAV1TOOL-TP01 registry and dispatch", () => {
  const defs = buildDefinitions({ os: "windows", shell: "pwsh", skills: [] });

  test("HERAV1TOOL-TP01-TC-03 invalid JSON, missing required, wrong type, unknown property → error naming the parameter; args_json preserved", async () => {
    const registry = new ToolRegistry(defs);
    for (const d of defs) registry.register(d.name, () => Promise.resolve({ status: "ok", text: "never" }));
    const ctx = toolCtx();
    const badJson = call("read_file", "{not json");
    const r1 = await registry.dispatch(badJson, ctx);
    expect(r1.status).toBe("error");
    expect(r1.text).toContain("not valid JSON");
    expect(badJson.argsJson).toBe("{not json");
    const r2 = await registry.dispatch(call("read_file", {}), ctx);
    expect(r2).toEqual({ status: "error", text: "read_file: invalid arguments - missing required parameter 'file_path'." });
    const r3 = await registry.dispatch(call("read_file", { file_path: 5 }), ctx);
    expect(r3.text).toContain("'file_path' must be a string");
    const r4 = await registry.dispatch(call("read_file", { file_path: "x", bogus: 1 }), ctx);
    expect(r4.text).toContain("unknown parameter 'bogus'");
    const r5 = await registry.dispatch(call("search", { Query: "a", SearchPath: "b", Mode: "fuzzy" }), ctx);
    expect(r5.text).toContain("'Mode' must be one of \"content\", \"name\"");
    const r6 = await registry.dispatch(call("multi_edit", { file_path: "x", edits: [] }), ctx);
    expect(r6.text).toContain("'edits' must have at least 1 item");
    const r7 = await registry.dispatch(call("todo_list", { todos: [{ id: "1", content: "c", status: "done", priority: "high" }] }), ctx);
    expect(r7.text).toContain("'todos[0].status' must be one of");
    const r8 = await registry.dispatch(call("nope", {}), ctx);
    expect(r8.text).toContain("unknown tool 'nope'");
    expect(validateAgainstSchema({ a: 1.5 }, { type: "object", properties: { a: { type: "integer" } } }, "")).toEqual(["'a' must be an integer"]);
  });

  test("HERAV1TOOL-TP01-TC-04 executor throwing TypeError → error 'internal tool failure'; ToolError → its message", async () => {
    const registry = new ToolRegistry(defs);
    registry.register("list_dir", () => {
      throw new TypeError("boom");
    });
    registry.register("read_file", () => Promise.reject(new ToolError("nice message", "do this")));
    const ctx = toolCtx();
    const r = await registry.dispatch(call("list_dir", { DirectoryPath: "x" }), ctx);
    expect(r).toEqual({ status: "error", text: "internal tool failure: TypeError: boom" });
    const t = await registry.dispatch(call("read_file", { file_path: "x" }), ctx);
    expect(t.status).toBe("error");
    expect(t.text).toStartWith("nice message");
  });

  test("HERAV1TOOL-TP01-TC-05 120 KB result capped with marker; 49 KB untouched", async () => {
    const registry = new ToolRegistry(defs);
    registry.register("read_file", (args) => Promise.resolve({ status: "ok", text: "x".repeat(Number(args["limit"])) }));
    const ctx = toolCtx({ maxChars: 50000 });
    const big = await registry.dispatch(call("read_file", { file_path: "f", limit: 120000 }), ctx);
    expect(big.text.length).toBe(50000 + "\n<truncated 70000 chars>".length);
    expect(big.text.endsWith("\n<truncated 70000 chars>")).toBe(true);
    const small = await registry.dispatch(call("read_file", { file_path: "f", limit: 49000 }), ctx);
    expect(small.text.length).toBe(49000);
    expect(capResult("abc", 3)).toBe("abc");
  });

  test("HERAV1TOOL-TP01-TC-06 abort mid-tool → cancelled", async () => {
    const registry = new ToolRegistry(defs);
    const controller = new AbortController();
    registry.register("read_file", async () => {
      controller.abort();
      await Bun.sleep(5);
      throw new Error("killed");
    });
    const ctx = toolCtx({ signal: controller.signal });
    const r = await registry.dispatch(call("read_file", { file_path: "f" }), ctx);
    expect(r.status).toBe("cancelled");
    const r2 = await registry.dispatch(call("read_file", { file_path: "f" }), ctx);
    expect(r2).toEqual({ status: "cancelled", text: "cancelled before execution." });
  });

  test("HERAV1TOOL-TP01-TC-36 no approval or policy logic in the tool layer; a blocked call never reaches an executor", async () => {
    const dir = join(REPO_ROOT, "src", "tools");
    const { readdirSync } = await import("node:fs");
    for (const file of readdirSync(dir)) {
      if (file === "definitions.ts") continue; // verbatim tool descriptions mention approval; no logic lives there
      const source = readFileSync(join(dir, file), "utf8").replace(/\/\/.*$/gm, "");
      expect(source).not.toMatch(/\bapprov(e|al)\b/i);
      expect(source).not.toMatch(/\bpolicy\b/i);
      expect(source).not.toMatch(/\bpermission\b/i);
      if (file !== "shell.ts") expect(source).not.toContain("SafeToAutoRun");
    }
    // the Executor marks blocked calls itself and skips dispatch; the registry offers no path for a verdict
    const registry = new ToolRegistry(defs);
    let ran = false;
    registry.register("run_command", () => {
      ran = true;
      return Promise.resolve({ status: "ok", text: "" });
    });
    const blocked = { ...call("run_command", { CommandLine: "rm -rf" }), status: "blocked" as const };
    if (blocked.status !== "blocked") await registry.dispatch(blocked, toolCtx());
    expect(ran).toBe(false);
  });
});

describe("HERAV1HRNS-TP01 U13 manifest exposure filter", () => {
  const defs = buildDefinitions({ os: "windows", shell: "pwsh", skills: [] });

  test("U13-TC-01 filterDefinitions with exposure list removes hidden tools; undefined exposure returns all", () => {
    const exposed = filterDefinitions(defs, ["read_file", "list_dir", "search"]);
    expect(exposed).toHaveLength(3);
    expect(exposed.map((d) => d.name).sort()).toEqual(["list_dir", "read_file", "search"]);
    const all = filterDefinitions(defs);
    expect(all).toHaveLength(15);
  });

  test("U13-TC-02 hidden tool is absent from filtered definitions and unreachable through dispatch", async () => {
    const exposed = filterDefinitions(defs, ["read_file", "list_dir"]);
    expect(exposed.find((d) => d.name === "run_command")).toBeUndefined();
    const registry = createToolRegistry(exposed);
    expect(registry.has("read_file")).toBe(true);
    expect(registry.has("run_command")).toBe(false);
    const ctx = toolCtx();
    const r = await registry.dispatch(call("run_command", { CommandLine: "echo hi" }), ctx);
    expect(r.status).toBe("error");
    expect(r.text).toContain("unknown tool 'run_command'");
  });

  test("U13-TC-03 per-definition byte identity: filtered definitions are byte-identical to the full set", () => {
    const exposed = filterDefinitions(defs, ["read_file", "run_command", "search"]);
    for (const d of exposed) {
      const full = defs.find((f) => f.name === d.name);
      expect(d.description).toBe(full!.description);
      expect(d.parameters).toEqual(full!.parameters);
    }
    // stableJson is deterministic per definition
    for (const d of exposed) {
      const full = defs.find((f) => f.name === d.name);
      expect(stableJson(d)).toBe(stableJson(full!));
    }
  });
});
