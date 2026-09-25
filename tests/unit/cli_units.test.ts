import { describe, expect, test } from "bun:test";
import { formatStatus, helpLines } from "../../src/cli/builtins.ts";
import { InputQueue } from "../../src/cli/console.ts";
import { CostLedger } from "../../src/cli/cost.ts";
import { deriveExitCode } from "../../src/cli/headless.ts";
import { QueueError, digest, parsePromptQueueFile, promptStepEvent } from "../../src/cli/prompt_queue.ts";
import { Renderer, summarizeArgs } from "../../src/cli/render.ts";
import { parseArgs } from "../../src/args.ts";
import { ConfigError, ProviderError } from "../../src/errors.ts";
import { nowTs, type AgentEvent } from "../../src/events.ts";
import { projectEvents } from "../../src/session/projection.ts";

const ev = (partial: Record<string, unknown>): AgentEvent => ({ ts: nowTs(), proc: "exec", ...partial }) as unknown as AgentEvent;
const pricing = { zai: { "glm-5.2": { input_per_1m: 1, cached_per_1m: 0.2, output_per_1m: 3 } }, openai: { "gpt-4.1-mini": { input_per_1m: 0.4, cached_per_1m: 0.1, output_per_1m: 1.6 } } };
const models = { generating: { provider: "zai", modelId: "glm-5.2" }, compacting: { provider: "openai", modelId: "gpt-4.1-mini" }, supervisor: { provider: "openai", modelId: "gpt-4.1-mini" }, memory: { provider: "openai", modelId: "mystery" } };

describe("HERAV1CLI-TP01 cost ledger", () => {
  test("HERAV1CLI-TP01-TC-01..03 four roles, formula, ? and ?+ for unpriced models, turn line, rebuild", () => {
    const ledger = new CostLedger(pricing, models);
    const turn = ev({ type: "turn_finished", role: "generating", uncached_input: 2850, cache_write: 0, cache_read: 18200, output: 412, stop_reason: "end" }) as Extract<AgentEvent, { type: "turn_finished" }>;
    ledger.onEvent(turn);
    // 2850 x 1 + 0 x 1.25 + 18200 x 0.2 + 412 x 3 = 2850 + 0 + 3640 + 1236 = 7726 / 1e6
    expect(ledger.roles.get("generating")?.costUsd).toBe(0.007726);
    expect(ledger.turnLine(turn)).toBe("Turn: in=21050 (cache 18200) out=412 | $0.0077 | session $0.0077");
    ledger.onEvent(ev({ type: "checkpoint_created", text: "cp", truncated_messages: 1, kept_messages: 1, usage: { uncached_input: 1000, cache_write: 0, cache_read: 0, output: 100, cost_usd: 0.00056 } }));
    ledger.onEvent({ ...ev({ type: "turn_finished", role: "memory", uncached_input: 10, cache_write: 0, cache_read: 0, output: 1 }), proc: "sup" } as AgentEvent);
    expect(ledger.partial).toBe(true);
    expect(ledger.formatTotal()).toBe("$0.0083+");
    const table = ledger.costTable();
    expect(table).toHaveLength(4);
    expect(table[0]).toStartWith("generating   glm-5.2");
    expect(table[1]).toContain("compacting");
    expect(table[2]).toMatch(/memory .*\| \?$/);
    expect(table[3]).toBe("Session total: $0.0083+");
    const rebuilt = new CostLedger(pricing, models);
    rebuilt.rebuild(projectEvents([turn, turn]));
    expect(rebuilt.roles.get("generating")?.calls).toBe(2);
    expect(rebuilt.totalUsd).toBe(0.015452);
    expect(new CostLedger(pricing, models).costTable()).toEqual(["No model calls yet.", "Session total: $0.0000"]);
  });
});

describe("HERAV1CLI-TP01 prompt queue", () => {
  test("HERAV1CLI-TP01-TC-04..06 six rules: fences 3-9, separators, commentary, nested fences, errors name the rule", () => {
    const text = ["```", "First prompt", "with two lines", "```", "", "---", "Step 2 commentary (never sent)", "`````md", "Second with ```inner``` fence", "`````", "---", "````", "Third", "````", ""].join("\n");
    const prompts = parsePromptQueueFile(text);
    expect(prompts).toEqual(["First prompt\nwith two lines", "Second with ```inner``` fence", "Third"]);
    const rule = (t: string): string => {
      try {
        parsePromptQueueFile(t);
      } catch (e) {
        expect(e).toBeInstanceOf(QueueError);
        expect(e).toBeInstanceOf(ConfigError);
        return (e as QueueError).rule;
      }
      return "none";
    };
    expect(rule("text before fence\n```\nx\n```")).toBe("first_line_fence");
    expect(rule("```\nunclosed")).toBe("unclosed_fence");
    expect(rule("```\na\n```\n```\nb\n```")).toBe("missing_separator");
    expect(rule("``````````\nten\n``````````")).toBe("fence_length");
    expect(rule("   \n\n")).toBe("zero_prompts");
    expect(rule("```\na\n```\nstray text\n---\n```\nb\n```")).toBe("content_after_close");
    expect(rule("```\na\n```\n---\n")).toBe("missing_separator");
    expect(digest("abc")).toMatch(/^[0-9a-f]{12}$/);
    const step = promptStepEvent(2, 3, "abc");
    expect(step).toMatchObject({ proc: "comm", type: "prompt_step", index: 2, total: 3, digest: digest("abc") });
  });
});

describe("HERAV1CLI-TP01 renderer and exit codes", () => {
  /** the CLI hooks feed the ledger before the renderer (cli/main.ts); the capture mirrors that order */
  interface Captured {
    r: { onEvent(e: AgentEvent): void; notice(t: string): void; readonly recent: string[] };
    out: string[];
    err: string[];
  }
  const capture = (opts: { showThinking?: boolean; jsonl?: boolean } = {}): Captured => {
    const out: string[] = [];
    const err: string[] = [];
    const ledger = new CostLedger(pricing, models);
    const inner = new Renderer({ showThinking: opts.showThinking ?? false, jsonl: opts.jsonl ?? false, out: (t) => out.push(t), err: (t) => err.push(t), ledger, statusLine: false, colors: false });
    return {
      r: {
        onEvent: (e) => {
          ledger.onEvent(e);
          inner.onEvent(e);
        },
        notice: (t) => inner.notice(t),
        get recent() {
          return inner.recent;
        },
      },
      out,
      err,
    };
  };

  test("HERAV1CLI-TP01-TC-07..09 tool lines, statuses, severity prefixes, SUPERVISOR notices, --show-thinking gating", () => {
    const { r, out } = capture();
    r.onEvent(ev({ type: "turn_started", role: "generating" }));
    r.onEvent(ev({ type: "thinking_delta", text: "hidden" }));
    r.onEvent(ev({ type: "text_delta", text: "Hello " }));
    r.onEvent(ev({ type: "text_delta", text: "world" }));
    r.onEvent(ev({ type: "tool_call_requested", id: "t1", tool: "run_command", args: { CommandLine: "rm -rf build", Blocking: true } }));
    r.onEvent(ev({ type: "tool_call_finished", id: "t1", status: "blocked", result: "blocked by supervisor: denylist (rm)", result_chars: 10 }));
    r.onEvent(ev({ type: "tool_call_requested", id: "t2", tool: "read_file", args: { file_path: "a.md" } }));
    r.onEvent(ev({ type: "tool_call_finished", id: "t2", status: "ok", result: "x", result_chars: 1 }));
    r.onEvent(ev({ type: "tool_call_finished", id: "t3", status: "error", result: "boom", result_chars: 4 }));
    r.onEvent(ev({ type: "tool_call_finished", id: "t4", status: "cancelled", result: "", result_chars: 0 }));
    r.onEvent(ev({ type: "tool_call_finished", id: "t5", status: "timed_out", result: "timed out: 30s", result_chars: 14 }));
    r.onEvent(ev({ type: "tool_call_finished", id: "t6", status: "unknown", result: "crash recovery", result_chars: 14 }));
    r.onEvent(ev({ type: "error", message: "slow", severity: "warning" }));
    r.onEvent(ev({ type: "error", message: "compacting", severity: "notice" }));
    r.onEvent(ev({ type: "error", message: "plain failure", severity: "error" }));
    r.onEvent({ ...ev({ type: "supervisor_intervention", kind: "guard_block", text: "blocked run_command (denylist): rm", turn_index: 1 }), proc: "sup" } as AgentEvent);
    r.onEvent({ ...ev({ type: "supervisor_intervention", kind: "governance_note", text: "hidden note", turn_index: 1 }), proc: "sup" } as AgentEvent);
    r.onEvent(ev({ type: "memory_injected", memory_ids: ["m1"], bytes: 10 }));
    r.onEvent(ev({ type: "executor_resumed", reason: "restart" }));
    r.onEvent(ev({ type: "turn_finished", role: "generating", uncached_input: 100, cache_write: 0, cache_read: 0, output: 10, stop_reason: "end" }));
    const text = out.join("");
    expect(text).toContain("Hello world\n  [tool] run_command 'rm -rf build'...\n    SUPERVISOR: blocked by supervisor: denylist (rm)\n");
    expect(text).toContain("  [tool] read_file 'a.md'...\n    OK. 1 chars.\n");
    expect(text).toContain("    ERROR: boom\n    cancelled\n");
    expect(text).toContain("timed out: timed out: 30s");
    expect(text).toContain("unknown: crash recovery");
    expect(text).toContain("WARNING: slow\n  compacting\nERROR: plain failure\n");
    expect(text).toContain("SUPERVISOR: blocked run_command (denylist): rm\n");
    expect(text).not.toContain("hidden");
    expect(text).toContain("  executor resumed (restart)\n");
    expect(text).toContain("  Turn: in=100 (cache 0) out=10 | $0.0001 | session $0.0001\n");
    expect(r.recent.length).toBeGreaterThan(5);
    expect(r.recent.some((l) => l.startsWith("SUPERVISOR:"))).toBe(true);
    const shown = capture({ showThinking: true });
    shown.r.onEvent(ev({ type: "thinking_delta", text: "visible" }));
    shown.r.onEvent({ ...ev({ type: "supervisor_intervention", kind: "governance_note", text: "note", turn_index: 1 }), proc: "sup" } as AgentEvent);
    shown.r.onEvent(ev({ type: "memory_injected", memory_ids: ["m1", "m2"], bytes: 10 }));
    expect(shown.out.join("")).toContain("visible");
    expect(shown.out.join("")).toContain("SUPERVISOR note: note");
    expect(shown.out.join("")).toContain("memories: 2 injected");
    expect(summarizeArgs({ Url: "https://x", other: 1 })).toBe("https://x");
    expect(summarizeArgs({ other: 1 })).toBe("");
  });

  test("HERAV1CLI-TP01-TC-10 jsonl purity: every event is one JSON line on stdout, notices on stderr", () => {
    const { r, out, err } = capture({ jsonl: true });
    r.onEvent(ev({ type: "text_delta", text: "hi" }));
    r.onEvent(ev({ type: "error", message: "WARNING: x", severity: "warning" }));
    r.notice("NOTICE: queued as next prompt");
    expect(out).toHaveLength(2);
    for (const line of out) expect(() => JSON.parse(line)).not.toThrow();
    expect(err).toEqual(["NOTICE: queued as next prompt\n"]);
  });

  test("HERAV1CLI-TP01-TC-11 exit-code matrix", () => {
    const finished = ev({ type: "turn_finished", role: "generating", uncached_input: 0, cache_write: 0, cache_read: 0, output: 0, stop_reason: "end" });
    expect(deriveExitCode([finished])).toBe(0);
    expect(deriveExitCode([], new ConfigError("bad", "fix"))).toBe(2);
    expect(deriveExitCode([], new ProviderError("x", "y"))).toBe(4);
    expect(deriveExitCode([ev({ type: "error", message: "provider", category: "provider", severity: "error" })])).toBe(3);
    expect(deriveExitCode([])).toBe(4);
    expect(deriveExitCode([ev({ type: "turn_finished", role: "generating", uncached_input: 0, cache_write: 0, cache_read: 0, output: 0, stop_reason: "cancelled" })])).toBe(4);
    expect(deriveExitCode([ev({ type: "error", message: "limit", category: "limit", severity: "error" }), finished])).toBe(4);
    expect(deriveExitCode([finished], undefined, { restartBudgetExhausted: true })).toBe(4);
    expect(deriveExitCode([finished, finished], undefined, { turnsExpected: 2 })).toBe(0);
    expect(deriveExitCode([finished], undefined, { turnsExpected: 2 })).toBe(4);
  });

  test("HERAV1CLI-TP01-TC-12 status formatting, help, input queue", () => {
    const lines = formatStatus({ sessionId: "s1", jsonlPath: "C:/d/s1.jsonl", children: [{ role: "executor", state: "ready", pid: 11, epoch: 1, heartbeatAgeMs: 1200, phase: "model_call", exitCode: null, signal: null }, { role: "supervisor", state: "exited", pid: 12, epoch: 1, heartbeatAgeMs: undefined, phase: undefined, exitCode: 1, signal: null }], restartsThisSession: 1, interventions: { guard_block: 2 }, turn: "running", turnSinceMs: 4200, turnToolCalls: 3, eventsAppended: 40 }, { queuedPrompt: "next", restartBudgetLeft: 0 });
    expect(lines[0]).toBe("Session: 's1' (C:/d/s1.jsonl)");
    expect(lines[1]).toBe("  executor   pid='11' ready (model_call) - heartbeat 1 s ago");
    expect(lines[2]).toBe("  supervisor pid='12' exited - no heartbeat yet (exit='1')");
    expect(lines[3]).toBe("Restarts this session: 1 (budget left this turn: 0)");
    expect(lines[4]).toBe("Interventions: guard_block=2 governance_note=0 stall_resume=0 restart_request=0 cost_alert=0");
    expect(lines[5]).toBe("Turn: running since 4 s (3 tool calls so far)");
    expect(lines[6]).toBe(`Queued prompt: yes (${digest("next")})`);
    expect(helpLines([{ name: "prime", description: "Prime" }])).toEqual(["Built-ins: /help, /cost, /status, /halt, /exit", "Workflows (1):", "  /prime: Prime"]);
    const q = new InputQueue();
    expect(q.set("a")).toBe("queued");
    expect(q.set("b")).toBe("replaced");
    expect(q.peekDigest()).toBe(digest("b"));
    expect(q.take()).toBe("b");
    expect(q.take()).toBeUndefined();
    expect(q.peekDigest()).toBeNull();
  });
});

describe("HERAV1CLI-TP01 U08 --approve-all flag and effect rendering", () => {
  test("TC-32..35: --approve-all parsed, effect_pending/effect_resolved rendered", () => {
    const parsed = parseArgs(["-p", "go", "--approve-all"]);
    expect(parsed.approveAll).toBe(true);
    expect(parsed.prompt).toBe("go");
    const parsed2 = parseArgs(["-p", "go"]);
    expect(parsed2.approveAll).toBe(false);

    const out: string[] = [];
    const r = new Renderer({ showThinking: false, jsonl: false, out: (t) => { out.push(t); }, err: () => {}, statusLine: false, colors: false });
    r.onEvent(ev({ type: "effect_pending", effect_id: "fx_1", tool: "run_command", reason: "SafeToAutoRun is false" }) as AgentEvent);
    expect(out.some((l) => l.includes("pending: run_command"))).toBe(true);
    out.length = 0;
    r.onEvent(ev({ type: "effect_resolved", effect_id: "fx_1", decision: "allow" }) as AgentEvent);
    expect(out.some((l) => l.includes("resolved: allow"))).toBe(true);
  });
});
