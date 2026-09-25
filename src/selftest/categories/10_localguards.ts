// Category 10 LocalGuards Controls (HERAV1STST-SP01 FR-18; SECREMED U14):
// Seven offline control checks verifying the security remediation controls are present and functional.
// Constructs LocalGuardsPlug and the factory directly; never runs a profile session, never calls a model.
// Network-free: no adapter calls, no child processes.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EffectDescriptor } from "../../harness/descriptor.ts";
import { createPlug } from "../../harness/plugs/factory.ts";
import { LocalGuardsPlug } from "../../harness/plugs/localguards.ts";
import { computeMac } from "../../config/migrate.ts";
import { renderToolResult } from "../../executor/injection.ts";
import { MemoryStore } from "../../supervisor/memory.ts";
import type { TestResult } from "../report.ts";
import type { SelftestContext } from "../runner.ts";

function pass(check: string, detail: string, durationMs: number): TestResult {
  return { category: "10", check, status: "pass", duration_seconds: Math.round(durationMs / 100) / 10, error_message: null, detail };
}

function fail(check: string, detail: string, durationMs: number): TestResult {
  return { category: "10", check, status: "fail", duration_seconds: Math.round(durationMs / 100) / 10, error_message: detail, detail };
}

const RUN_CTX = crypto.getRandomValues(new Uint8Array(16));

function desc(effectId: string, target: string, parameters: Record<string, unknown>): EffectDescriptor {
  return new EffectDescriptor({ effect_id: effectId, kind: "tool.invoke", target, parameters, run_ctx: RUN_CTX });
}

export async function localGuardsCategory(_ctx: SelftestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const tmpBase = join(import.meta.dir, "..", "..", "..", "tests", ".tmp", "selftest_localguards");
  rmSync(tmpBase, { recursive: true, force: true });

  // 1. read_outside_workspace_blocked
  {
    const start = performance.now();
    try {
      const ws = join(tmpBase, "ws1");
      mkdirSync(ws, { recursive: true });
      const plug = new LocalGuardsPlug({ denylist: [], workspace: ws });
      const outside = join(tmpBase, "outside.txt");
      writeFileSync(outside, "secret");
      const d = desc("eff_001", "read_file", { file_path: outside });
      const answer = plug.request(d);
      if (typeof answer === "object" && answer.answer === "block" && answer.reason.includes("workspace boundary")) {
        results.push(pass("read_outside_workspace_blocked", `blocked: ${answer.reason}`, performance.now() - start));
      } else {
        results.push(fail("read_outside_workspace_blocked", `expected block/workspace boundary, got ${JSON.stringify(answer)}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("read_outside_workspace_blocked", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 2. protected_path_blocked
  {
    const start = performance.now();
    try {
      const ws = join(tmpBase, "ws2");
      mkdirSync(ws, { recursive: true });
      const protectedFile = join(ws, "secret.env");
      writeFileSync(protectedFile, "KEY=value");
      const plug = new LocalGuardsPlug({ denylist: [], workspace: ws, protected_paths: ["secret.env"] });
      const d = desc("eff_002", "read_file", { file_path: protectedFile });
      const answer = plug.request(d);
      if (typeof answer === "object" && answer.answer === "block" && answer.reason.includes("protected paths")) {
        results.push(pass("protected_path_blocked", `blocked: ${answer.reason}`, performance.now() - start));
      } else {
        results.push(fail("protected_path_blocked", `expected block/protected paths, got ${JSON.stringify(answer)}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("protected_path_blocked", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 3. key_shape_in_url_blocked
  {
    const start = performance.now();
    try {
      const ws = join(tmpBase, "ws3");
      mkdirSync(ws, { recursive: true });
      const plug = new LocalGuardsPlug({ denylist: [], workspace: ws });
      const d = desc("eff_003", "read_url_content", { Url: "https://example.com/?token=sk-ant-abcdef1234567890" });
      const answer = plug.request(d);
      if (typeof answer === "object" && answer.answer === "block" && answer.reason.includes("key shape")) {
        results.push(pass("key_shape_in_url_blocked", `blocked: ${answer.reason}`, performance.now() - start));
      } else {
        results.push(fail("key_shape_in_url_blocked", `expected block/key shape, got ${JSON.stringify(answer)}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("key_shape_in_url_blocked", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 4. governed_refused
  {
    const start = performance.now();
    try {
      const ws = join(tmpBase, "ws4");
      mkdirSync(ws, { recursive: true });
      let threw = false;
      try {
        createPlug({ profile: "governed", denylist: [], workspace: ws });
      } catch (e) {
        threw = true;
        if (e instanceof Error && e.constructor.name === "ProfileError") {
          results.push(pass("governed_refused", `ProfileError: ${e.message}`, performance.now() - start));
        } else {
          results.push(fail("governed_refused", `expected ProfileError, got ${e?.constructor?.name ?? typeof e}`, performance.now() - start));
        }
      }
      if (!threw) results.push(fail("governed_refused", "createPlug did not throw for governed profile", performance.now() - start));
    } catch (e) {
      results.push(fail("governed_refused", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 5. run_command_pending
  {
    const start = performance.now();
    try {
      const ws = join(tmpBase, "ws5");
      mkdirSync(ws, { recursive: true });
      const plug = new LocalGuardsPlug({ denylist: [], workspace: ws, approval: "unsafe" });
      const d = desc("eff_005", "run_command", { CommandLine: "echo hello" });
      const answer = plug.request(d);
      if (answer === "pending") {
        results.push(pass("run_command_pending", "pending (no operator prefix, unsafe approval)", performance.now() - start));
      } else {
        results.push(fail("run_command_pending", `expected pending, got ${JSON.stringify(answer)}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("run_command_pending", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 6. tool_result_delimited
  {
    const start = performance.now();
    try {
      const wrapped = renderToolResult("file content here", "read_file", "call_001");
      const unwrapped = renderToolResult("edited", "edit", "call_002");
      if (wrapped.includes("<untrusted_content") && wrapped.includes("</untrusted_content>") && !unwrapped.includes("<untrusted_content")) {
        results.push(pass("tool_result_delimited", "wrapped tool result delimited, unwrapped passthrough", performance.now() - start));
      } else {
        results.push(fail("tool_result_delimited", `wrapped=${wrapped.slice(0, 50)}, unwrapped=${unwrapped.slice(0, 50)}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("tool_result_delimited", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  // 7. tampered_memory_dropped
  {
    const start = performance.now();
    try {
      const memDir = join(tmpBase, "mem7");
      mkdirSync(memDir, { recursive: true });
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const secretPath = join(memDir, ".memory.secret");
      writeFileSync(secretPath, Buffer.from(secret).toString("hex"));
      const hash = "abcdef012345";
      const memFile = join(memDir, `workspace-${hash}.jsonl`);
      const validLine: Record<string, unknown> = { id: "mem_1", text: "valid memory", scope: "workspace", tags: [], created: "2026-09-13T00:00:00Z", last_used: "2026-09-13T00:00:00Z", uses: 0, source_session: "test" };
      const validMac = computeMac(validLine, Buffer.from(secret));
      const tamperedLine: Record<string, unknown> = { id: "mem_2", text: "tampered memory", scope: "workspace", tags: [], created: "2026-09-13T00:00:00Z", last_used: "2026-09-13T00:00:00Z", uses: 0, source_session: "test", mac: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" };
      writeFileSync(memFile, `${JSON.stringify({ ...validLine, mac: validMac })}\n${JSON.stringify(tamperedLine)}\n`);
      const store = MemoryStore.open(memDir, hash, { secretPath });
      const hasIntegrityWarning = store.warnings.some((w) => w.includes("integrity check"));
      const hasValid = store.memories.has("mem_1");
      const hasTampered = store.memories.has("mem_2");
      if (hasIntegrityWarning && hasValid && !hasTampered) {
        results.push(pass("tampered_memory_dropped", `valid kept, tampered skipped, ${store.warnings.length} warning(s)`, performance.now() - start));
      } else {
        results.push(fail("tampered_memory_dropped", `warning=${hasIntegrityWarning}, valid=${hasValid}, tampered=${hasTampered}`, performance.now() - start));
      }
    } catch (e) {
      results.push(fail("tampered_memory_dropped", e instanceof Error ? e.message : String(e), performance.now() - start));
    }
  }

  rmSync(tmpBase, { recursive: true, force: true });
  return results;
}
