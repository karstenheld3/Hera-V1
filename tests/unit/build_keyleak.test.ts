import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeDir } from "../harness/procs.ts";

describe("HERAV1DIST-TP01 key-leak guard (TC-06)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("keyleak");
  });
  afterEach(() => {
    removeDir(dir);
  });

  test("HERAV1DIST-TP01-TC-06: real key detected, placeholder and comment not detected", async () => {
    // Real key-shaped value (40+ chars)
    const realKey = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
    writeFileSync(join(dir, "real.txt"), `OPENAI_API_KEY=${realKey}\n`);

    // Empty value (placeholder)
    writeFileSync(join(dir, "empty.txt"), `OPENAI_API_KEY=\n`);

    // Commented out short value
    writeFileSync(join(dir, "comment.txt"), `# OPENAI_API_KEY=abc\n`);

    // Run the PowerShell module function via bun subprocess
    const proc = Bun.spawn(
      ["pwsh", "-NoProfile", "-Command", `Import-Module '${join(import.meta.dir, "..", "..", "build.keyleak.psm1")}' -Function Get-KeyLeaks; Get-KeyLeaks '${dir}' | ConvertTo-Json`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const stderr = await new Response(proc.stderr as ReadableStream).text();

    expect(code).toBe(0);
    expect(stderr).toBe("");

    // Parse the result - should contain real.txt but not empty.txt or comment.txt
    const lines = stdout.trim().split("\n").map((l) => l.trim().replace(/^"|"$/g, ""));
    expect(lines.some((l) => l.includes("real.txt"))).toBe(true);
    expect(lines.some((l) => l.includes("empty.txt"))).toBe(false);
    expect(lines.some((l) => l.includes("comment.txt"))).toBe(false);

    // The output must never contain the actual key value
    expect(stdout).not.toContain(realKey);
  });
});
