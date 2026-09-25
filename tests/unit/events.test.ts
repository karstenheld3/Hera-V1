import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_TYPES, fromJsonl, nowTs, readJsonlFile, toJsonl, type AgentEvent } from "../../src/events.ts";
import { EventParseError } from "../../src/errors.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "sessions");
const lines = (name: string): string[] =>
  readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);

describe("HERAV1AGNT-TP01 events", () => {
  test("HERAV1AGNT-TP01-TC-05 round trip of all 20 types, no null for absent optionals", () => {
    const seen = new Set<string>();
    for (const line of lines("v2_session.jsonl")) {
      const event = fromJsonl(line);
      seen.add(event.type);
      const again = toJsonl(event);
      expect(fromJsonl(again)).toEqual(event);
      // cost_usd: null is a value (model missing from pricing); every other null would be an absent optional
      expect(again.replace('"cost_usd":null', "")).not.toContain("null");
      expect(again).not.toContain("undefined");
      expect(again.split("\n")).toHaveLength(1);
    }
    expect([...seen].sort()).toEqual([...EVENT_TYPES].sort());
    expect(EVENT_TYPES).toHaveLength(20);
  });

  test("HERAV1AGNT-TP01-TC-06 unknown type raises EventParseError with type and line number", () => {
    const bad = '{"ts":"2026-01-15 10:00:00.000","proc":"exec","type":"approval_required","action":"x","detail":"y"}';
    let caught: unknown;
    try {
      fromJsonl(bad, 7);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EventParseError);
    const err = caught as EventParseError;
    expect(err.message).toContain("approval_required");
    expect(err.message).toContain("line 7");
    expect(err.exitCode).toBe(4);
  });

  test("HERAV1AGNT-TP01-TC-07 truncated last line: error on that line only; file reader yields N-1 events and one warning", () => {
    const all = lines("truncated.jsonl");
    expect(() => fromJsonl(all[all.length - 1]!, all.length)).toThrow(EventParseError);
    for (const line of all.slice(0, -1)) expect(() => fromJsonl(line)).not.toThrow();
    const result = readJsonlFile(join(FIXTURES, "truncated.jsonl"));
    expect(result.events).toHaveLength(all.length - 1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toStartWith("WARNING:");
    expect(result.truncatedTail).toBe(true);
  });

  test("HERAV1AGNT-TP01-TC-08 V1 lines parse with proc exec, role generating, legacy flag; approval_required rejected", () => {
    let approvalErrors = 0;
    let parsed = 0;
    for (const [i, line] of lines("v1_session.jsonl").entries()) {
      if (line.includes('"approval_required"')) {
        expect(() => fromJsonl(line, i + 1)).toThrow(EventParseError);
        approvalErrors++;
        continue;
      }
      const event = fromJsonl(line, i + 1);
      parsed++;
      expect(event.proc).toBe("exec");
      expect(event.legacy).toBe(true);
      if (event.type === "turn_finished" || event.type === "turn_started") expect(event.role).toBe("generating");
      if (event.type === "turn_finished") expect(event.cache_write).toBe(0);
      expect(toJsonl(event)).not.toContain("legacy");
    }
    expect(approvalErrors).toBe(1);
    expect(parsed).toBe(11);
  });

  test("HERAV1AGNT-TP01-TC-09 error category and severity optional and closed", () => {
    const base = '"ts":"2026-01-15 10:00:00.000","proc":"exec","type":"error","message":"x"';
    expect(fromJsonl(`{${base}}`).type).toBe("error");
    const withCategory = fromJsonl(`{${base},"category":"provider"}`);
    expect(withCategory.type === "error" && withCategory.category).toBe("provider");
    for (const c of ["config", "process", "limit"]) expect(() => fromJsonl(`{${base},"category":"${c}"}`)).not.toThrow();
    expect(() => fromJsonl(`{${base},"category":"approval"}`)).toThrow(EventParseError);
    // severity vocabulary
    for (const s of ["error", "warning", "notice"]) expect(() => fromJsonl(`{${base},"severity":"${s}"}`)).not.toThrow();
    expect(() => fromJsonl(`{${base},"severity":"fatal"}`)).toThrow(EventParseError);
    const withSev = fromJsonl(`{${base},"severity":"warning"}`);
    expect(withSev.type === "error" && withSev.severity).toBe("warning");
  });

  test("HERAV1AGNT-TP01-TC-10 tool_call_finished status set", () => {
    const line = (status: string) =>
      `{"ts":"2026-01-15 10:00:00.000","proc":"exec","type":"tool_call_finished","id":"tc_1","status":"${status}","result":"","result_chars":0}`;
    for (const s of ["ok", "error", "timed_out", "unknown", "cancelled", "blocked"]) expect(() => fromJsonl(line(s))).not.toThrow();
    expect(() => fromJsonl(line("approved"))).toThrow(EventParseError);
  });

  test("HERAV1AGNT-TP01-TC-11 nowTs format and monotonic non-decrease", () => {
    let previous = "";
    for (let i = 0; i < 1000; i++) {
      const ts = nowTs();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      expect(ts >= previous).toBe(true);
      previous = ts;
    }
  });

  test("toJsonl omits undefined optionals and keeps snake_case wire names", () => {
    const event: AgentEvent = { ts: nowTs(), proc: "exec", type: "user_message", content: "hi", expanded_workflow: undefined };
    const line = toJsonl(event);
    expect(line).not.toContain("expanded_workflow");
    expect(line).toContain('"content":"hi"');
  });
});
