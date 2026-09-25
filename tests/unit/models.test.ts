import { describe, expect, test } from "bun:test";
import { ConfigError, EventParseError, IpcError, HeraError, ProviderError, ToolError } from "../../src/errors.ts";
import { PROC_IDS, PROVIDER_IDS, ROLE_NAMES, TOOL_CALL_STATUSES, type Message, type ToolCall, type Usage } from "../../src/models.ts";

describe("HERAV1AGNT-TP01 models and errors", () => {
  test("canonical name sets match the shared vocabulary", () => {
    expect([...ROLE_NAMES]).toEqual(["generating", "compacting", "supervisor", "memory"]);
    expect([...PROC_IDS]).toEqual(["comm", "exec", "sup"]);
    expect([...PROVIDER_IDS]).toEqual(["openai", "anthropic", "zai", "scripted"]);
    expect([...TOOL_CALL_STATUSES]).toEqual(["pending", "ok", "error", "timed_out", "unknown", "cancelled", "blocked"]);
  });

  test("canonical types compile with camelCase fields incl. cacheWrite", () => {
    const usage: Usage = { uncachedInput: 1, cacheWrite: 2, cacheRead: 3, output: 4 };
    const call: ToolCall = { id: "tc_1", name: "read_file", argsJson: "{}", args: {}, status: "blocked" };
    const message: Message = { role: "assistant", content: "", toolCalls: [call], usage };
    expect(message.toolCalls?.[0]?.status).toBe("blocked");
    expect(usage.cacheWrite).toBe(2);
  });

  test("HERAV1AGNT-TP01-TC-12 HeraError subclasses carry exit code, category, and the corrective action", () => {
    const config = new ConfigError("agent-config.json: roles.generating missing", "Add a roles.generating entry.");
    expect(config).toBeInstanceOf(HeraError);
    expect(config.exitCode).toBe(2);
    expect(config.category).toBe("config");
    expect(config.message).toContain("Add a roles.generating entry.");

    const provider = new ProviderError("HTTP 429 from openai", "Retry later or lower the request rate.", { provider: "openai", model: "gpt-4.1-mini", retryable: true });
    expect(provider.exitCode).toBe(3);
    expect(provider.category).toBe("provider");
    expect(provider.retryable).toBe(true);
    expect(provider.provider).toBe("openai");

    const ipc = new IpcError("no ack within 5000 ms", "Check that the Communicator is alive.");
    expect(ipc.exitCode).toBe(4);
    expect(ipc.category).toBe("process");

    const tool = new ToolError("file not found", "Check the path.");
    expect(tool.exitCode).toBe(1);
    expect(tool.category).toBeUndefined();

    const parse = new EventParseError("unknown event type 'x'", 3);
    expect(parse.exitCode).toBe(4);
    expect(parse.lineNo).toBe(3);
    expect(parse.message).toContain("line 3");

    // type-level only (never executed): the corrective action is mandatory (HERAV1AGNT-SP01 IG-01)
    const compileCheck = (): ConfigError =>
      // @ts-expect-error - missing action argument must not compile
      new ConfigError("message only");
    expect(typeof compileCheck).toBe("function");
  });
});
