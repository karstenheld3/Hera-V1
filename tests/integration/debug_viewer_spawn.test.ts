import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ENTRY, VIEWER_GUARD_ENV, spawnViewer, viewerCommand } from "../../src/debug/spawn_viewer.ts";
import { REPO_ROOT } from "../harness/procs.ts";

const TMP = join(import.meta.dir, "..", ".tmp", "viewer_spawn");
const bunProcesses = (): number => {
  const out = Bun.spawnSync(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"Name = 'bun.exe'\" | Where-Object { $_.CommandLine -match 'debug-viewer' } | Measure-Object).Count"], { stdout: "pipe", stderr: "ignore" });
  return Number(new TextDecoder().decode(out.stdout).trim() || "0");
};

describe("[integration] HERAV1DEBG-TP01 viewer spawn (HERAV1-FL-0002 guards)", () => {
  test("the viewer command targets the package entry, never Bun.main (the caller's script)", () => {
    expect(PACKAGE_ENTRY.replace(/\\/g, "/")).toBe(join(REPO_ROOT, "src", "index.ts").replace(/\\/g, "/"));
    const cmd = viewerCommand();
    expect(cmd).toContain("--debug-viewer");
    expect(cmd.join(" ")).not.toContain(Bun.main);
  });

  test("recursion guard: a process carrying HERA_VIEWER_SPAWNED refuses to spawn; the entry refuses non-viewer work", async () => {
    const warnings: string[] = [];
    const handle = spawnViewer({ env: { [VIEWER_GUARD_ENV]: "1" }, onWarning: (l) => warnings.push(l) });
    expect(handle).toBeNull();
    expect(warnings[0]).toContain("recursion guard");
    const proc = Bun.spawn([process.execPath, "run", PACKAGE_ENTRY, "--version"], { env: { ...process.env, [VIEWER_GUARD_ENV]: "1" }, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(code).toBe(2);
    expect(await new Response(proc.stderr as ReadableStream).text()).toContain("spawn recursion guard");
  });

  test("HERAV1DEBG-IP01-TC-10/11 windowless link: one plain child connects over loopback, renders lines, exits on close; no process survives", async () => {
    if (process.platform !== "win32") return;
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    const probe = join(TMP, "probe.json");
    const warnings: string[] = [];
    const handle = spawnViewer({ newWindow: false, env: { ...process.env, HERA_VIEWER_PROBE: probe, HERA_VIEWER_NO_WAIT: "1", HERA_VIEWER_STDOUT: "1" }, onWarning: (l) => warnings.push(l) });
    expect(handle).not.toBeNull();
    const h = handle!;
    for (let i = 0; i < 10; i++) await h.writer.write(`${JSON.stringify({ ts: "2026-09-06 15:00:00.000", proc: "exec", dom: "tool", op: "start", tool: "read_file", i })}\n`);
    await h.writer.write("not json\n");
    const deadline = performance.now() + 5000;
    while (!h.connected() && performance.now() < deadline) await Bun.sleep(50);
    expect(h.connected()).toBe(true);
    await Bun.sleep(300);
    expect(existsSync(probe)).toBe(true);
    expect(JSON.parse(readFileSync(probe, "utf8"))).toMatchObject({ console: expect.any(Boolean) });
    h.close();
    const exitDeadline = performance.now() + 5000;
    while (h.alive() && performance.now() < exitDeadline) await Bun.sleep(50);
    expect(h.alive()).toBe(false);
    await Bun.sleep(300);
    expect(bunProcesses()).toBe(0);
    expect(warnings).toEqual([]);
  }, 20000);

  test("HERAV1DEBG-IP01-TC-11 windowed spawn (opt-in: HERA_TEST_VIEWER_WINDOW=1): a real console window appears and closes itself", async () => {
    if (process.platform !== "win32" || process.env["HERA_TEST_VIEWER_WINDOW"] !== "1") return;
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    const probe = join(TMP, "probe_window.json");
    const warnings: string[] = [];
    const handle = spawnViewer({ env: { ...process.env, HERA_VIEWER_PROBE: probe, HERA_VIEWER_NO_WAIT: "1" }, onWarning: (l) => warnings.push(l) });
    expect(handle).not.toBeNull();
    const h = handle!;
    await h.writer.write(`${JSON.stringify({ ts: "2026-09-06 15:00:00.000", proc: "comm", dom: "app", op: "startup", mode: "console", version: "2.0.0" })}\n`);
    const deadline = performance.now() + 8000;
    while (!h.connected() && performance.now() < deadline) await Bun.sleep(50);
    expect(h.connected()).toBe(true);
    await Bun.sleep(500);
    expect(JSON.parse(readFileSync(probe, "utf8"))).toMatchObject({ console: true });
    h.close();
    await Bun.sleep(1500);
    expect(bunProcesses()).toBe(0);
  }, 30000);
});
