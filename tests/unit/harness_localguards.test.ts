// LocalGuards plug tests (HERAV1HRNS-TP01 IG-05; former HERAV1SUPV-TP01 TC-01..TC-07).
// Tests the same denylist, shell-wrapper, and workspace-boundary rules as the former
// supervisor/guards.ts tests, now through the GateProvider interface.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DENYLIST } from "../../src/config/schema.ts";
import { EffectDescriptor } from "../../src/harness/descriptor.ts";
import { LocalGuardsPlug, READ_TOOLS, insideWorkspace, isProtected, isShellWrapper, matchDenylist, normalizeFirstToken, resolveRealPath, tokenize } from "../../src/harness/plugs/localguards.ts";
import { KEY_SHAPE_PATTERN, redactKeyShapes, scanKeyShapes } from "../../src/harness/plugs/keyshapes.ts";
import { makeTempDir, removeDir } from "../harness/procs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeDescriptor(target: string, params: Record<string, unknown>): EffectDescriptor {
  return new EffectDescriptor({
    effect_id: `fx_test`,
    kind: "tool.invoke",
    target,
    parameters: params,
  });
}

describe("HERAV1HRNS-TP01 LocalGuards (former SUPV-TP01 TC-01..TC-07)", () => {
  test("TC-01 first-token normalization: path, quotes, .exe, case", () => {
    expect(normalizeFirstToken("Remove-Item x")).toBe("remove-item");
    expect(normalizeFirstToken('"C:\\Windows\\System32\\cmd.exe" /c dir')).toBe("cmd");
    expect(normalizeFirstToken("./bin/RM.EXE -rf")).toBe("rm");
    expect(normalizeFirstToken("  'rm' -rf /")).toBe("rm");
    expect(normalizeFirstToken("")).toBe("");
    expect(tokenize('a "b c" d')).toEqual(["a", '"b c"', "d"]);
  });

  test("TC-02/03 denylist: single-token equality, multi-token prefix, case-insensitive; safe commands pass", () => {
    const deny = [...DEFAULT_DENYLIST];
    expect(matchDenylist("rm -rf build", deny)).toBe("rm");
    expect(matchDenylist("RM build", deny)).toBe("rm");
    expect(matchDenylist("C:\\tools\\rm.exe build", deny)).toBe("rm");
    expect(matchDenylist("git push --force origin main", deny)).toBe("git push --force");
    expect(matchDenylist("git push origin main", deny)).toBeUndefined();
    expect(matchDenylist("format-list", deny)).toBeUndefined();
    expect(matchDenylist("Remove-Item -Recurse x", deny)).toBe("Remove-Item");
    expect(matchDenylist("rmdir /s x", deny)).toBe("rmdir");
    expect(matchDenylist("ls -la", deny)).toBeUndefined();
    expect(matchDenylist("bun test", deny)).toBeUndefined();
    expect(matchDenylist("echo rm", deny)).toBeUndefined();
  });

  test("TC-04 shell wrapper detection", () => {
    expect(isShellWrapper("pwsh -Command Remove-Item x")).toBe(true);
    expect(isShellWrapper("powershell.exe -c rm x")).toBe(true);
    expect(isShellWrapper("cmd /c del x")).toBe(true);
    expect(isShellWrapper("bash -c 'rm -rf /'")).toBe(true);
    expect(isShellWrapper("pwsh -NoProfile -File script.ps1")).toBe(false);
    expect(isShellWrapper("bash script.sh")).toBe(false);
    expect(isShellWrapper("bun run build")).toBe(false);
  });

  test("TC-05..07 LocalGuardsPlug.request: order denylist -> wrapper; workspace boundary on write tools; junction and non-existent targets", () => {
    const root = makeTempDir("guards");
    dirs.push(root);
    const ws = join(root, "ws");
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(root, "outside"));
    const deny = [...DEFAULT_DENYLIST];
    const plug = new LocalGuardsPlug({ denylist: deny, workspace: ws, approval: "off" });

    // denylist
    let answer = plug.request(makeDescriptor("run_command", { CommandLine: "rm -rf x", SafeToAutoRun: true }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("denylist") });

    // shell wrapper
    answer = plug.request(makeDescriptor("run_command", { CommandLine: "pwsh -Command rm x", SafeToAutoRun: true }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("shell wrapper") });

    // safe command
    answer = plug.request(makeDescriptor("run_command", { CommandLine: "bun test" }));
    expect(answer).toBe("allow");

    // write inside workspace
    answer = plug.request(makeDescriptor("write_to_file", { TargetFile: join(ws, "src", "new.ts"), CodeContent: "", EmptyFile: true }));
    expect(answer).toBe("allow");

    // write to non-existent path inside workspace (parent doesn't exist yet)
    answer = plug.request(makeDescriptor("write_to_file", { TargetFile: join(ws, "deep", "missing", "new.ts") }));
    expect(answer).toBe("allow");

    // write outside workspace
    answer = plug.request(makeDescriptor("edit", { file_path: join(root, "outside", "x.ts") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("workspace boundary") });

    // multi_edit outside workspace via ..
    answer = plug.request(makeDescriptor("multi_edit", { file_path: join(ws, "..", "outside", "x.ts") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("workspace boundary") });

    // read_file outside workspace - blocked (read boundary, U04)
    answer = plug.request(makeDescriptor("read_file", { file_path: join(root, "outside", "x.ts") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("workspace boundary") });

    // junction inside workspace pointing outside resolves to its real target
    try {
      symlinkSync(join(root, "outside"), join(ws, "link"), "junction");
      answer = plug.request(makeDescriptor("write_to_file", { TargetFile: join(ws, "link", "escape.ts") }));
      expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("workspace boundary") });
    } catch {
      /* junction creation not permitted on this host */
    }

    // insideWorkspace / resolveRealPath helpers
    expect(insideWorkspace(resolveRealPath(join(ws, "src"), ws), resolveRealPath(ws, ws))).toBe(true);
    expect(insideWorkspace(resolveRealPath(join(root, "outside"), ws), resolveRealPath(ws, ws))).toBe(false);

    // verdict latency: 200 evaluations well under 5 ms each
    const started = performance.now();
    for (let i = 0; i < 200; i++) plug.request(makeDescriptor("run_command", { CommandLine: `echo ${i}` }));
    expect((performance.now() - started) / 200).toBeLessThan(5);
  });

  test("LocalGuardsPlug admit/resolve/halt are no-ops", () => {
    const plug = new LocalGuardsPlug({ denylist: [], workspace: ".", approval: "off" });
    const admitResult = plug.admit("", "", 1);
    expect(admitResult.admitted).toBe(true);
    if (admitResult.admitted) {
      expect(admitResult.run_ctx.length).toBe(16);
    }
    expect(() => plug.resolve("fx_1")).not.toThrow();
    expect(() => plug.halt("test")).not.toThrow();
  });
});

describe("HERAV1LGRD-TP01 TC-03..TC-07: read boundary, allowlist, protected paths", () => {
  test("TC-03: outside-workspace read blocked for read_file, list_dir, search", () => {
    const root = makeTempDir("guards");
    dirs.push(root);
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(root, "outside"));
    const plug = new LocalGuardsPlug({ denylist: [], workspace: ws });

    let answer = plug.request(makeDescriptor("read_file", { file_path: join(root, "outside", "x.ts") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by workspace boundary") });

    answer = plug.request(makeDescriptor("list_dir", { DirectoryPath: join(root, "outside") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by workspace boundary") });

    answer = plug.request(makeDescriptor("search", { SearchPath: join(root, "outside") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by workspace boundary") });
  });

  test("TC-04: allowlisted read allowed; write tools never use allowlist", () => {
    const root = makeTempDir("guards");
    dirs.push(root);
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(root, "outside"));
    const outsidePath = join(root, "outside", "x.ts");
    const plug = new LocalGuardsPlug({ denylist: [], workspace: ws, read_allowlist: [outsidePath] });

    // allowlisted read -> allow
    let answer = plug.request(makeDescriptor("read_file", { file_path: outsidePath }));
    expect(answer).toBe("allow");

    // non-allowlisted read -> block
    answer = plug.request(makeDescriptor("read_file", { file_path: join(root, "outside", "y.ts") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by workspace boundary") });

    // write tool with allowlisted path -> still block (write tools never use allowlist)
    answer = plug.request(makeDescriptor("edit", { file_path: outsidePath }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by workspace boundary") });
  });

  test("TC-05: outside-workspace write blocked for edit, write_to_file, multi_edit", () => {
    const root = makeTempDir("guards");
    dirs.push(root);
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(root, "outside"));
    const plug = new LocalGuardsPlug({ denylist: [], workspace: ws });

    let answer = plug.request(makeDescriptor("edit", { file_path: join(root, "outside", "x.ts") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by workspace boundary") });

    answer = plug.request(makeDescriptor("write_to_file", { TargetFile: join(root, "outside", "x.ts") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by workspace boundary") });

    answer = plug.request(makeDescriptor("multi_edit", { file_path: join(root, "outside", "x.ts") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by workspace boundary") });
  });

  test("TC-06: protected path blocked inside workspace for read and write", () => {
    const root = makeTempDir("guards");
    dirs.push(root);
    const ws = join(root, "ws");
    mkdirSync(join(ws, "src"), { recursive: true });
    const plug = new LocalGuardsPlug({ denylist: [], workspace: ws, protected_paths: [".api-keys.txt", "agent-config.json", "~/.ssh/id_rsa"] });

    // read of protected file inside workspace -> block
    let answer = plug.request(makeDescriptor("read_file", { file_path: join(ws, ".api-keys.txt") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by protected paths") });

    // write to protected file inside workspace -> block
    answer = plug.request(makeDescriptor("write_to_file", { TargetFile: join(ws, "agent-config.json") }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by protected paths") });

    // read of ~/.ssh/id_rsa -> block (~ expands to user home)
    answer = plug.request(makeDescriptor("read_file", { file_path: "~/.ssh/id_rsa" }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by protected paths") });

    // win32 case folding: .API-KEYS.TXT matches .api-keys.txt
    if (process.platform === "win32") {
      answer = plug.request(makeDescriptor("read_file", { file_path: join(ws, ".API-KEYS.TXT") }));
      expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by protected paths") });
    }

    // symlink resolving to protected file -> block
    try {
      symlinkSync(join(ws, ".api-keys.txt"), join(ws, "link_to_keys"), "file");
      answer = plug.request(makeDescriptor("read_file", { file_path: join(ws, "link_to_keys") }));
      expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by protected paths") });
    } catch {
      /* symlinks not permitted on this host */
    }
  });

  test("TC-07: allowlisted path that is also protected is blocked", () => {
    const root = makeTempDir("guards");
    dirs.push(root);
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(root, "outside"));
    const outsidePath = join(root, "outside", ".api-keys.txt");
    const plug = new LocalGuardsPlug({
      denylist: [],
      workspace: ws,
      read_allowlist: [outsidePath],
      protected_paths: [".api-keys.txt"],
    });

    // path in both allowlist and protected -> block (protected wins)
    const answer = plug.request(makeDescriptor("read_file", { file_path: outsidePath }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by protected paths") });
  });

  test("READ_TOOLS constant has the three read tools", () => {
    expect(READ_TOOLS.has("read_file")).toBe(true);
    expect(READ_TOOLS.has("list_dir")).toBe(true);
    expect(READ_TOOLS.has("search")).toBe(true);
    expect(READ_TOOLS.has("edit")).toBe(false);
  });
});

describe("HERAV1LGRD-TP01 TC-08..TC-10: key-shape scan on egress parameters", () => {
  const plug = new LocalGuardsPlug({ denylist: [], workspace: ".", approval: "off" });

  test("TC-08: read_url_content URL with key-shaped token is blocked", () => {
    const keyUrl = "https://example.com/?token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const answer = plug.request(makeDescriptor("read_url_content", { Url: keyUrl }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by key shape") });
    expect((answer as { reason: string }).reason).toContain("URL");
  });

  test("TC-08: read_url_content URL without key-shaped token is allowed", () => {
    const safeUrl = "https://example.com/page.html";
    expect(plug.request(makeDescriptor("read_url_content", { Url: safeUrl }))).toBe("allow");
  });

  test("TC-09: search_web query with key-shaped token is blocked", () => {
    const keyQuery = "sk-1234567890abcdef my search query";
    const answer = plug.request(makeDescriptor("search_web", { query: keyQuery }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by key shape") });
    expect((answer as { reason: string }).reason).toContain("query");
  });

  test("TC-09: search_web query without key-shaped token is allowed", () => {
    expect(plug.request(makeDescriptor("search_web", { query: "hello world" }))).toBe("allow");
  });

  test("TC-10: run_command line with key-shaped token is blocked", () => {
    const keyCmd = "echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const answer = plug.request(makeDescriptor("run_command", { CommandLine: keyCmd }));
    expect(answer).toEqual({ answer: "block", reason: expect.stringContaining("blocked by key shape") });
    expect((answer as { reason: string }).reason).toContain("command line");
  });

  test("TC-10: run_command line without key-shaped token is allowed", () => {
    expect(plug.request(makeDescriptor("run_command", { CommandLine: "echo hello" }))).toBe("allow");
  });

  test("scanKeyShapes and redactKeyShapes work correctly", () => {
    expect(scanKeyShapes("no key here")).toBe(false);
    expect(scanKeyShapes("sk-abcdefgh")).toBe(true);
    expect(scanKeyShapes("sk-ant-abcdefgh")).toBe(true);
    expect(scanKeyShapes("a".repeat(40))).toBe(true);
    expect(redactKeyShapes("key sk-abcdefgh end")).toBe("key *** end");
    expect(redactKeyShapes("no keys")).toBe("no keys");
  });

  test("KEY_SHAPE_PATTERN is exported", () => {
    expect(KEY_SHAPE_PATTERN).toBeInstanceOf(RegExp);
    expect(KEY_SHAPE_PATTERN.test("sk-abcdefgh")).toBe(true);
    expect(KEY_SHAPE_PATTERN.test("safe text")).toBe(false);
  });
});

describe("HERAV1LGRD-TP01-TC-11..TC-18: approval policy and decision handling (U07)", () => {
  const ws = makeTempDir("guards");
  dirs.push(ws);

  function makePlug(opts: { approval?: string; network_commands?: readonly string[]; denylist?: readonly string[] }): LocalGuardsPlug {
    return new LocalGuardsPlug({
      denylist: opts.denylist ?? [],
      workspace: ws,
      approval: opts.approval as "unsafe" | "all" | "off" | undefined,
      network_commands: opts.network_commands,
    });
  }

  test("TC-11: SafeToAutoRun=false returns pending under unsafe approval", () => {
    const plug = makePlug({ approval: "unsafe" });
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_11",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: false },
    }));
    expect(answer).toBe("pending");
  });

  test("TC-12: SafeToAutoRun=true returns allow under unsafe approval", () => {
    const plug = makePlug({ approval: "unsafe" });
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_12",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: true },
    }));
    expect(answer).toBe("allow");
  });

  test("TC-13: network command returns pending under unsafe approval", () => {
    const plug = makePlug({ approval: "unsafe" });
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_13",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "curl https://example.com", SafeToAutoRun: true },
    }));
    expect(answer).toBe("pending");
  });

  test("TC-14: approval=off allows everything regardless of SafeToAutoRun", () => {
    const plug = makePlug({ approval: "off" });
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_14",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "curl https://example.com", SafeToAutoRun: false },
    }));
    expect(answer).toBe("allow");
  });

  test("TC-15: approval=all returns pending for every run_command", () => {
    const plug = makePlug({ approval: "all" });
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_15",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: true },
    }));
    expect(answer).toBe("pending");
  });

  test("TC-16: resolve with deny stores decision and blocks on re-request", () => {
    const plug = makePlug({ approval: "unsafe" });
    const desc = new EffectDescriptor({
      effect_id: "fx_16",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: false },
    });
    expect(plug.request(desc)).toBe("pending");
    plug.resolve("fx_16", "deny");
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_16",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: false },
    }));
    expect(answer).toEqual({ answer: "block", reason: "denied by user" });
  });

  test("TC-17: resolve with allow stores decision and allows on re-request", () => {
    const plug = makePlug({ approval: "unsafe" });
    const desc = new EffectDescriptor({
      effect_id: "fx_17",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: false },
    });
    expect(plug.request(desc)).toBe("pending");
    plug.resolve("fx_17", "allow");
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_17",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: false },
    }));
    expect(answer).toBe("allow");
  });

  test("TC-18: resolve without decision does not store (no-op)", () => {
    const plug = makePlug({ approval: "unsafe" });
    const desc = new EffectDescriptor({
      effect_id: "fx_18",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: false },
    });
    expect(plug.request(desc)).toBe("pending");
    plug.resolve("fx_18");
    // No stored decision → re-request returns pending again
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_18",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "echo hello", SafeToAutoRun: false },
    }));
    expect(answer).toBe("pending");
  });

  test("TC-19: custom network_commands list is used", () => {
    const plug = makePlug({ approval: "unsafe", network_commands: ["mytool"] });
    const answer = plug.request(new EffectDescriptor({
      effect_id: "fx_19",
      kind: "tool.invoke",
      target: "run_command",
      parameters: { CommandLine: "mytool --flag", SafeToAutoRun: true },
    }));
    expect(answer).toBe("pending");
  });

  test("TC-20: default network_commands list includes curl, wget, nc, ssh", () => {
    const plug = makePlug({ approval: "unsafe" });
    for (const cmd of ["curl", "wget", "nc", "ssh"]) {
      const answer = plug.request(new EffectDescriptor({
        effect_id: `fx_20_${cmd}`,
        kind: "tool.invoke",
        target: "run_command",
        parameters: { CommandLine: `${cmd} example.com`, SafeToAutoRun: true },
      }));
      expect(answer).toBe("pending");
    }
  });
});
