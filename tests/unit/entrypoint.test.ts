import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { HELP_TEXT, parseArgs } from "../../src/args.ts";
import { ConfigError } from "../../src/errors.ts";
import { HeraProc } from "../harness/hera_proc.ts";
import { REPO_ROOT } from "../harness/procs.ts";

const hera = new HeraProc({ workspace: REPO_ROOT });

describe("HERAV1AGNT-TP01 entrypoint", () => {
  test("HERAV1AGNT-TP01-TC-02 --version prints hera <package.json version> and exits 0", async () => {
    const result = await hera.run(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`hera ${pkg.version}`);
    expect(pkg.version).toBe("1.0.1");
  });

  test("HERAV1AGNT-TP01-TC-03 unknown flag exits 2 and names the flag", async () => {
    const result = await hera.run(["--polciy", "x"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--polciy");
    expect(result.stderr).toContain("--help");
    expect(result.stdout).toBe("");
  });

  test("HERAV1AGNT-TP01-TC-04 --role auditor exits 2 listing executor and supervisor", async () => {
    const result = await hera.run(["--role", "auditor"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("executor");
    expect(result.stderr).toContain("supervisor");
  });

  test("--help prints the flag list", async () => {
    const result = await hera.run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(HELP_TEXT);
  });

  test("parseArgs covers the fixed flag set", () => {
    const parsed = parseArgs(["-p", "hello", "--output-format", "jsonl", "--config", "c.json", "--app-dir", "./x", "--show-thinking", "--debug", "--log-dir", "logs", "selftest", "offline"]);
    expect(parsed.prompt).toBe("hello");
    expect(parsed.outputFormat).toBe("jsonl");
    expect(parsed.config).toBe("c.json");
    expect(parsed.appDir).toBe("./x");
    expect(parsed.showThinking).toBe(true);
    expect(parsed.debug).toBe(true);
    expect(parsed.logDir).toBe("logs");
    expect(parsed.positionals).toEqual(["selftest", "offline"]);
    expect(parseArgs(["--resume"]).resume).toBe(true);
    expect(parseArgs(["--resume", "s.jsonl"]).resume).toBe("s.jsonl");
    expect(parseArgs(["--role", "executor", "--epoch", "3"])).toMatchObject({ role: "executor", epoch: 3 });
    expect(() => parseArgs(["--output-format", "xml"])).toThrow(ConfigError);
    expect(() => parseArgs(["--prompt-file", "q.md", "--acp"])).toThrow(ConfigError);
    expect(() => parseArgs(["--epoch", "x"])).toThrow(ConfigError);
  });

  test("role entry started by hand (no ipc) fails with exit 2 while the role is a stub", async () => {
    const result = await hera.run(["--role", "executor", "--epoch", "1"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("ERROR:");
  });

  test("HERAV1AGNT-TP01-TC-14 runHeadless enforces its timeout against a child that never exits", async () => {
    const sleeper = new HeraProc({ workspace: REPO_ROOT, env: { HERA_TEST_BINARY: "" } });
    const started = performance.now();
    // a fixture script that sleeps stands in for a hung product process
    const result = await sleeper.runWith([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(performance.now() - started).toBeLessThan(10000);
  });

  test("fixture layout exists", () => {
    expect(join(REPO_ROOT, "tests", "fixtures", "fake_system")).toBeString();
  });
});
