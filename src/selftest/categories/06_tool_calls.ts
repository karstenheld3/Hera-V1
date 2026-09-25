// Category 06 Model Tool Calls (HERAV1STST-SP01 FR-09; HERAV1STST-IP01 IS-06): per provider a two-turn read_file round
// trip with the real tool definition - turn 1 asserts a `read_file` tool call with parseable arguments and stop
// `tool_calls`; turn 2 feeds the tool result and asserts text with stop `end`.

import type { Message } from "../../models.ts";
import { buildDefinitions, definitionByName } from "../../tools/definitions.ts";
import { modelPerProvider, roleFor } from "../discovery.ts";
import type { TestResult } from "../report.ts";
import { roundTrip, runLive, type RoundTripOutcome, type SelftestContext } from "../runner.ts";

export const TOOL_TEST_SYSTEM = "You are a test agent. When asked to read a file, call the read_file tool with the exact path given. After the tool result, answer with exactly: SELFTEST OK";
export const TOOL_TEST_FILE = "E:/selftest/README.md";
export const TOOL_TEST_USER = `Read the file ${TOOL_TEST_FILE} with the read_file tool.`;
export const TOOL_TEST_RESULT = "# Selftest\n\nThis file exists only for the tool-call round trip.";

export function toolTurnFailure(o: RoundTripOutcome): string | undefined {
  if (o.toolCalls.length === 0) return "no tool_call delta";
  const call = o.toolCalls[0] as RoundTripOutcome["toolCalls"][number];
  if (call.name !== "read_file") return `tool_call '${call.name}' (expected 'read_file')`;
  if (call.args === undefined) {
    try {
      JSON.parse(call.argsJson);
    } catch (error) {
      return `tool_call arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
    return "tool_call arguments not parsed";
  }
  if (o.stopReason !== "tool_calls") return `stop reason '${o.stopReason}' (expected 'tool_calls')`;
  return undefined;
}

export async function toolCallsCategory(ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const perProvider = modelPerProvider(ctx.config, ctx.discovery.testable);
  const readFile = definitionByName(buildDefinitions({ os: process.platform, shell: process.platform === "win32" ? "pwsh" : "sh", skills: [] }), "read_file");
  if (readFile === undefined) throw new Error("read_file definition missing from TOOL_DEFINITIONS");
  const entries = [...perProvider.values()];
  if (entries.length === 0) ctx.out("  no testable model per provider - nothing to run");
  let i = 0;
  for (const t of entries) {
    if (ctx.signal.aborted) break;
    i++;
    const role = roleFor(t, t.defaultEffort, ctx.config);
    results.push(
      await runLive(ctx, { category: "06", check: `${t.provider}:${t.model.model_id}`, model_id: t.model.model_id, provider: t.provider, method: t.method, effort: t.defaultEffort }, `${t.provider} ${t.model.model_id} (${t.method}, ${t.defaultEffort}) read_file round trip`, t.keyPresent, async () => {
        const turn1 = await roundTrip(ctx, role, { system: TOOL_TEST_SYSTEM, user: TOOL_TEST_USER, tools: [readFile] });
        const failure1 = toolTurnFailure(turn1);
        if (failure1 !== undefined) return { outcome: turn1, failure: failure1 };
        const call = turn1.toolCalls[0] as RoundTripOutcome["toolCalls"][number];
        const callId = "selftest_call_1";
        const messages: Message[] = [
          { role: "user", content: TOOL_TEST_USER },
          { role: "assistant", content: turn1.text, toolCalls: [{ id: callId, name: call.name, args: call.args, argsJson: call.argsJson, status: "ok", result: TOOL_TEST_RESULT }] },
          { role: "tool", content: TOOL_TEST_RESULT, toolCallId: callId },
        ];
        const turn2 = await roundTrip(ctx, role, { system: TOOL_TEST_SYSTEM, messages, tools: [readFile] });
        const merged: RoundTripOutcome = {
          text: turn2.text,
          toolCalls: turn2.toolCalls,
          usage: { uncachedInput: turn1.usage.uncachedInput + turn2.usage.uncachedInput, cacheWrite: turn1.usage.cacheWrite + turn2.usage.cacheWrite, cacheRead: turn1.usage.cacheRead + turn2.usage.cacheRead, output: turn1.usage.output + turn2.usage.output },
          stopReason: turn2.stopReason,
          costUsd: turn1.costUsd === undefined && turn2.costUsd === undefined ? undefined : (turn1.costUsd ?? 0) + (turn2.costUsd ?? 0),
          durationMs: turn1.durationMs + turn2.durationMs,
        };
        const failure2 = turn2.text.trim().length === 0 ? "turn 2: no text after the tool result" : turn2.stopReason !== "end" ? `turn 2: stop reason '${turn2.stopReason}' (expected 'end')` : undefined;
        return { outcome: merged, failure: failure2 };
      }, { i, n: entries.length }),
    );
  }
  return results;
}
