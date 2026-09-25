import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/procs.ts";

const buildPs1 = join(REPO_ROOT, "build.ps1");
const buildBat = join(REPO_ROOT, "build.bat");
const keyleakModule = join(REPO_ROOT, "build.keyleak.psm1");

describe("HERAV1DIST-TP01 build pipeline (TC-07..TC-13)", () => {
  test("HERAV1DIST-TP01-TC-07: build.ps1 and build.bat exist", () => {
    expect(existsSync(buildPs1)).toBe(true);
    expect(existsSync(buildBat)).toBe(true);
  });

  test("HERAV1DIST-TP01-TC-07b: keyleak module exists and is importable", async () => {
    expect(existsSync(keyleakModule)).toBe(true);
    const proc = Bun.spawn(["pwsh", "-NoProfile", "-Command", `Import-Module '${keyleakModule}' -Function Get-KeyLeaks; (Get-Command Get-KeyLeaks) -ne $null`], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("True");
  });

  test("HERAV1DIST-TP01-TC-08: build.ps1 -SyncOnly exits 0 and creates staging", async () => {
    const proc = Bun.spawn(["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", buildPs1, "-SyncOnly"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const stderr = await new Response(proc.stderr as ReadableStream).text();

    expect(code).toBe(0);
    expect(stdout).toContain("Sync complete");
    // Staging folders should exist after -SyncOnly
    expect(existsSync(join(REPO_ROOT, "src", "bundled", "config"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "src", "bundled", "agent"))).toBe(true);
    // .api-keys.txt and agent-config.json must NOT be in staging
    expect(existsSync(join(REPO_ROOT, "src", "bundled", "config", ".api-keys.txt"))).toBe(false);
    expect(existsSync(join(REPO_ROOT, "src", "bundled", "config", "agent-config.json"))).toBe(false);
    // Config JSON files should be there
    expect(existsSync(join(REPO_ROOT, "src", "bundled", "config", "model-registry.json"))).toBe(true);
  });

  test("HERAV1DIST-TP01-TC-10: .bun-version is 1.4.2", async () => {
    const { readFileSync } = await import("node:fs");
    const version = readFileSync(join(REPO_ROOT, ".bun-version"), "utf8").trim();
    expect(version).toBe("1.4.2");
  });

  test("HERAV1DIST-TP01-TC-11: package.json build script matches FR-01 command", async () => {
    const pkg = await import(join(REPO_ROOT, "package.json"), { with: { type: "json" } });
    const buildScript = pkg.default.scripts.build;
    expect(buildScript).toContain("--compile");
    expect(buildScript).toContain("--bytecode");
    expect(buildScript).toContain("--minify");
    expect(buildScript).toContain("--target=bun-windows-x64");
    expect(buildScript).toContain("--no-compile-autoload-dotenv");
    expect(buildScript).toContain("--no-compile-autoload-bunfig");
    expect(buildScript).toContain("--asset");
    expect(buildScript).toContain("src/bundled/agent");
    expect(buildScript).toContain("src/index.ts");
  });

  test("HERAV1DIST-TP01-TC-12: .gitignore has staging folder patterns", async () => {
    const gitignore = await import("node:fs").then((m) => m.readFileSync(join(REPO_ROOT, ".gitignore"), "utf8"));
    expect(gitignore).toContain("src/bundled/config/");
    expect(gitignore).toContain("src/bundled/agent/");
    expect(gitignore).toContain("src/bundled/tools/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain("config/.api-keys.txt");
  });

  test("HERAV1DIST-TP01-TC-13: build.ps1 contains the stable hera.exe copy", async () => {
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(buildPs1, "utf8");
    expect(content).toContain("hera.exe");
    expect(content).toContain("Stable copy");
  });
});
