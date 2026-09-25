import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolError } from "../../src/errors.ts";
import { nowTs, toJsonl, type AgentEvent } from "../../src/events.ts";
import { loadPromptSystem } from "../../src/prompt/loader.ts";
import type { AdapterDelta, ProviderAdapter } from "../../src/providers/base.ts";
import { ScriptedAdapter } from "../../src/providers/scripted.ts";
import { Gate } from "../../src/harness/gate.ts";
import { ScriptedPlug } from "../../src/harness/plugs/scripted.ts";
import { buildDefinitions } from "../../src/tools/definitions.ts";
import { createToolRegistry } from "../../src/tools/index.ts";
import { MAX_STATUS_WAIT_SECONDS, commandStatus, commandTableOf, runCommand, shellArgv } from "../../src/tools/shell.ts";
import { askUserQuestion, skill, todoList } from "../../src/tools/state.ts";
import { resolveSessionFile, trajectorySearch } from "../../src/tools/trajectory.ts";
import { htmlToText, readUrlContent, renderSearchResults, searchWeb, viewContentChunk } from "../../src/tools/web.ts";
import { REPO_ROOT, makeTempDir, removeDir } from "../harness/procs.ts";
import { call, toolCtx } from "../harness/tool_ctx.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

async function toolError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return (e as Error).message;
  }
  throw new Error("expected a ToolError");
}

const pwshAvailable = Bun.which("pwsh") !== null;

describe("HERAV1TOOL-TP01 shell tools", () => {
  test("shellArgv per platform", () => {
    expect(shellArgv("dir", "win32")).toEqual(["pwsh", "-NoProfile", "-NonInteractive", "-Command", "dir"]);
    expect(shellArgv("ls", "linux")).toEqual(["sh", "-c", "ls"]);
  });

  test.skipIf(!pwshAvailable)("HERAV1TOOL-TP01-TC-20 blocking pwsh command with Cwd; pid registered then deregistered", async () => {
    const root = makeTempDir("shell");
    dirs.push(root);
    const ctx = toolCtx({ workspace: REPO_ROOT });
    const r = await runCommand({ CommandLine: "Write-Output (Get-Location).Path; Write-Output 'done'", Cwd: root, Blocking: true }, ctx);
    expect(r.status).toBe("ok");
    expect(r.text.startsWith("Exit code 0\nOutput:\n")).toBe(true);
    expect(r.text.toLowerCase()).toContain(root.toLowerCase());
    expect(r.text.trimEnd().endsWith("done")).toBe(true);
    expect(ctx.children.registered).toHaveLength(1);
    expect(ctx.children.live()).toEqual([]);
    const failing = await runCommand({ CommandLine: "exit 3", Blocking: true }, ctx);
    expect(failing.text.startsWith("Exit code 3")).toBe(true);
  }, 30000);

  test.skipIf(!pwshAvailable)("HERAV1TOOL-TP01-TC-21 background command: command_status running → done; clamp note at 300 s", async () => {
    const ctx = toolCtx();
    const r = await runCommand({ CommandLine: "Start-Sleep -Milliseconds 1500; Write-Output 'late'", Blocking: false }, ctx);
    expect(r.text).toMatch(/^Command running in background with ID cmd_[0-9a-f]{8}\. Check it with command_status\./);
    const id = r.meta?.commandId as string;
    const running = await commandStatus({ CommandId: id, OutputCharacterCount: 1000 }, ctx);
    expect(running.text.startsWith("Status: running")).toBe(true);
    const done = await commandStatus({ CommandId: id, OutputCharacterCount: 1000, WaitDurationSeconds: 300 }, ctx);
    expect(done.text).toContain("Status: done\nExit code 0");
    expect(done.text).toContain(`NOTE: WaitDurationSeconds 300 clamped to ${MAX_STATUS_WAIT_SECONDS} s (tool contract maximum).`);
    expect(done.text.trimEnd().endsWith("late")).toBe(true);
    const tail = await commandStatus({ CommandId: id, OutputCharacterCount: 2 }, ctx);
    expect(tail.text.trimEnd().endsWith("te")).toBe(true);
    expect(await toolError(() => commandStatus({ CommandId: "cmd_nope", OutputCharacterCount: 10 }, ctx))).toContain(`Known background IDs: ${id}`);
    expect(ctx.children.live()).toEqual([]);
  }, 30000);

  test.skipIf(!pwshAvailable)("HERAV1TOOL-TP01-TC-22 background command finishing before the wait → final output plus CommandId", async () => {
    const ctx = toolCtx();
    const r = await runCommand({ CommandLine: "Write-Output 'quick'", Blocking: false, WaitMsBeforeAsync: 8000 }, ctx);
    expect(r.text).toMatch(/^Command cmd_[0-9a-f]{8} finished before the wait ended\.\nExit code 0\nOutput:\nquick/);
    expect(r.meta?.commandId).toBeDefined();
  }, 30000);

  test.skipIf(!pwshAvailable)("HERAV1TOOL-TP01-TC-23 100 KB output and invalid UTF-8 survive; missing Cwd → error before spawn", async () => {
    const ctx = toolCtx();
    const r = await runCommand({ CommandLine: "$s = 'x' * 1000; 1..100 | ForEach-Object { Write-Output $s }; [Console]::OpenStandardOutput().Write([byte[]](0xff,0xfe,0x0a), 0, 3)", Blocking: true }, ctx);
    expect(r.text.length).toBeGreaterThan(100000);
    expect(r.text).toContain("\uFFFD");
    const before = ctx.children.registered.length;
    expect(await toolError(() => runCommand({ CommandLine: "dir", Cwd: join(REPO_ROOT, "no-such-dir"), Blocking: true }, ctx))).toContain("is not an existing directory");
    expect(ctx.children.registered.length).toBe(before);
  }, 30000);

  test.skipIf(!pwshAvailable)("HERAV1TOOL-TP01-TC-24 abort kills the child; table has no live entries afterwards; SafeToAutoRun has no effect", async () => {
    const controller = new AbortController();
    const ctx = toolCtx({ signal: controller.signal });
    const pending = runCommand({ CommandLine: "Start-Sleep -Seconds 30; Write-Output 'never'", Blocking: true, SafeToAutoRun: true }, ctx);
    await Bun.sleep(700);
    controller.abort();
    const r = await pending;
    expect(r.status).toBe("cancelled");
    expect(r.text).not.toContain("never");
    expect(commandTableOf(ctx).live()).toEqual([]);
    expect(ctx.children.live()).toEqual([]);
    const ctx2 = toolCtx();
    const denied = await runCommand({ CommandLine: "Write-Output 'ran'", Blocking: true, SafeToAutoRun: false }, ctx2);
    expect(denied.text).toContain("ran");
    const bg = await runCommand({ CommandLine: "Start-Sleep -Seconds 30", Blocking: false }, ctx2);
    expect(bg.meta?.commandId).toBeDefined();
    const result = await commandTableOf(ctx2).terminateAll();
    expect(result.terminated).toHaveLength(1);
    expect(result.survivors).toEqual([]);
  }, 30000);
});

describe("HERAV1TOOL-TP01 web tools", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        switch (url.pathname) {
          case "/page.html":
            return new Response("<html><head><title>T</title><script>var x=1;</script><style>b{}</style></head><body><h1>Hello &amp; welcome</h1><p>First   para</p><p>Second</p></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
          case "/data.json":
            return new Response(JSON.stringify({ a: 1 }), { headers: { "content-type": "application/json" } });
          case "/blob.bin":
            return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { "content-type": "application/octet-stream" } });
          case "/404":
            return new Response("nope", { status: 404 });
          case "/big.txt":
            return new Response("y".repeat(20000), { headers: { "content-type": "text/plain" } });
          case "/trickle": {
            const stream = new ReadableStream({
              async start(controller) {
                for (let i = 0; i < 100; i++) {
                  controller.enqueue(new TextEncoder().encode("tick\n"));
                  await Bun.sleep(200);
                }
                controller.close();
              },
            });
            return new Response(stream, { headers: { "content-type": "text/plain" } });
          }
          default: {
            const m = /^\/redirect\/(\d+)$/.exec(url.pathname);
            if (m !== null) {
              const n = Number(m[1]);
              if (n <= 0) return new Response("landed", { headers: { "content-type": "text/plain" } });
              return new Response(null, { status: 302, headers: { location: `/redirect/${n - 1}` } });
            }
            await Promise.resolve();
            return new Response("not found", { status: 404 });
          }
        }
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
  });

  test("HERAV1TOOL-TP01-TC-25 scripted results in agent format; adapter without support → V1 error text", async () => {
    const scripted = new ScriptedAdapter(join(REPO_ROOT, "tests", "fixtures", "scripts", "script_roles.jsonl"), {});
    const role = { name: "websearch" as const, modelId: "glm-5.2", provider: "scripted" as const, method: "temperature" as const, effort: "low", params: { method: "temperature" as const, temperature: 0 }, maxInput: 1, maxOutput: 1, contextWindow: 1 };
    const ctx = toolCtx({ websearch: scripted });
    ctx.adapters.websearchRole = { ...role, name: "generating" };
    const r = await searchWeb({ query: "example" }, ctx);
    expect(r.text).toBe("- Example\n  https://example.com/\n  An example page.\n\nUse read_url_content on a result URL to read further.");
    const five = renderSearchResults(Array.from({ length: 7 }, (_, i) => ({ title: `T${i}`, url: `https://e.com/${i}`, snippet: "s".repeat(400) })));
    expect(five.split("\n- ")).toHaveLength(5);
    expect(five).not.toContain("s".repeat(301));
    const unsupported: ProviderAdapter = {
      provider: "zai",
      streamTurn: async function* () {
        yield { kind: "usage", usage: { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, stopReason: "end", thinkingPayloads: [] } as AdapterDelta;
      },
      supportsWebSearch: () => false,
      webSearch: () => Promise.resolve([]),
    };
    const ctx2 = toolCtx({ websearch: unsupported });
    ctx2.adapters.websearchRole = ctx.adapters.websearchRole;
    expect(await toolError(() => searchWeb({ query: "x" }, ctx2))).toBe("search_web unavailable -> provider adapter for 'glm-5.2' has no web search support. Configure a different websearch model (EC-19). Change roles.websearch to a provider with web search.");
    expect(await toolError(() => searchWeb({ query: "x" }, toolCtx()))).toContain("no 'websearch' role configured");
  });

  test("HERAV1TOOL-TP01-TC-26 /page.html → text without tags, chunk 0, document_id, count, meta.host", async () => {
    const ctx = toolCtx();
    const r = await readUrlContent({ Url: `${base}/page.html` }, ctx);
    expect(r.status).toBe("ok");
    expect(r.meta?.host).toBe(`127.0.0.1:${server.port}`);
    expect(r.text).toMatch(/^Document 'doc_0001' fetched from http:\/\/127\.0\.0\.1:\d+\/page\.html: 1 chunk of up to 8000 chars\./);
    expect(r.text).toContain("[chunk 1 of 1]\nHello & welcome\nFirst para\nSecond");
    expect(r.text).not.toContain("<");
    expect(r.text).not.toContain("var x");
    expect(htmlToText("<p>a&#39;b&#x41;</p>")).toBe("a'bA");
  });

  test("HERAV1TOOL-TP01-TC-27 /trickle with an injected 3 s deadline → deadline error", async () => {
    const ctx = toolCtx({ timeouts: { fetchMs: 3000 } });
    const started = performance.now();
    const message = await toolError(() => readUrlContent({ Url: `${base}/trickle` }, ctx));
    expect(message).toContain("aborted after 3 s wall-clock deadline");
    expect(performance.now() - started).toBeLessThan(8000);
  }, 15000);

  test("HERAV1TOOL-TP01-TC-28 json pass-through; binary content-type error; 404; redirect chain of 6; schemeless URL", async () => {
    const ctx = toolCtx();
    const json = await readUrlContent({ Url: `${base}/data.json` }, ctx);
    expect(json.text).toContain('[chunk 1 of 1]\n{"a":1}');
    expect(await toolError(() => readUrlContent({ Url: `${base}/blob.bin` }, ctx))).toContain("Content-Type 'application/octet-stream'");
    expect(await toolError(() => readUrlContent({ Url: `${base}/404` }, ctx))).toContain("HTTP 404");
    expect(await toolError(() => readUrlContent({ Url: `${base}/redirect/6` }, ctx))).toContain("more than 5 redirects");
    const landed = await readUrlContent({ Url: `${base}/redirect/3` }, ctx);
    expect(landed.text).toContain("landed");
    expect(await toolError(() => readUrlContent({ Url: "example.com/page" }, ctx))).toContain("URL must be HTTP or HTTPS");
    expect(await toolError(() => readUrlContent({ Url: "http://127.0.0.1:9/closed" }, ctx))).toContain("Cannot fetch");
  });

  test("HERAV1TOOL-TP01-TC-29 view_content_chunk: valid, out of range, unknown id", async () => {
    const ctx = toolCtx();
    const r = await readUrlContent({ Url: `${base}/big.txt` }, ctx);
    expect(r.text).toContain("3 chunks of up to 8000 chars");
    const second = await viewContentChunk({ document_id: "doc_0001", position: 2 }, ctx);
    expect(second.text.startsWith("[chunk 2 of 3]\n")).toBe(true);
    expect(second.text.length).toBe("[chunk 2 of 3]\n".length + 8000);
    const third = await viewContentChunk({ document_id: "doc_0001", position: 3 }, ctx);
    expect(third.text.length).toBe("[chunk 3 of 3]\n".length + 4000);
    expect(await toolError(() => viewContentChunk({ document_id: "doc_0001", position: 4 }, ctx))).toContain("valid range is 1..3");
    expect(await toolError(() => viewContentChunk({ document_id: "doc_9999", position: 1 }, ctx))).toContain("Known ids: doc_0001");
  });

  test("HERAV1TOOL-TP01-TC-38 egress descriptor target carries the full URL", async () => {
    const plug = new ScriptedPlug([{ answer: "allow" }]);
    const gate = new Gate(plug);
    gate.admit("h", "p", 1);
    const ctx = toolCtx();
    ctx.gate = gate;
    const url = `${base}/page.html`;
    await readUrlContent({ Url: url }, ctx);
    expect(plug.calls.length).toBe(1);
    expect(plug.calls[0]?.kind).toBe("net.egress");
    expect(plug.calls[0]?.target).toBe(url);
  });
});

describe("HERAV1TOOL-TP01 trajectory, state, skill, interaction", () => {
  const ev = (partial: Omit<Extract<AgentEvent, { type: "text_delta" }>, "ts" | "proc"> | Omit<Extract<AgentEvent, { type: "user_message" }>, "ts" | "proc">): AgentEvent => ({ ts: nowTs(), proc: "exec", ...partial }) as AgentEvent;

  function sessions(): string {
    const root = makeTempDir("traj");
    dirs.push(root);
    const dir = join(root, "sessions");
    mkdirSync(dir);
    const lines = [ev({ type: "user_message", content: "please refactor the parser module" }), ev({ type: "text_delta", text: "Looking at the parser now." }), ev({ type: "text_delta", text: "The tokenizer is unrelated." })].map(toJsonl);
    lines.splice(2, 0, "{not json at all");
    for (let i = 0; i < 60; i++) lines.push(toJsonl(ev({ type: "text_delta", text: `filler ${i}` })));
    writeFileSync(join(dir, "2026-01-15_100000_abcd.jsonl"), `${lines.join("\n")}\n`);
    writeFileSync(join(dir, "2026-01-15_110000_ef01.jsonl"), `${toJsonl(ev({ type: "text_delta", text: "second session" }))}\n`);
    writeFileSync(join(dir, "2026-01-16_090000_0000.jsonl"), `${toJsonl(ev({ type: "text_delta", text: "third" }))}\n`);
    return dir;
  }

  test("HERAV1TOOL-TP01-TC-30 id resolution: exact, stem, unique prefix, ambiguous, unknown", () => {
    const dir = sessions();
    expect(resolveSessionFile(dir, "2026-01-15_100000_abcd.jsonl")).toBe(join(dir, "2026-01-15_100000_abcd.jsonl"));
    expect(resolveSessionFile(dir, "2026-01-15_100000_abcd")).toBe(join(dir, "2026-01-15_100000_abcd.jsonl"));
    expect(resolveSessionFile(dir, "2026-01-16")).toBe(join(dir, "2026-01-16_090000_0000.jsonl"));
    expect(() => resolveSessionFile(dir, "2026-01-15")).toThrow(/ambiguous: 2026-01-15_100000_abcd, 2026-01-15_110000_ef01/);
    expect(() => resolveSessionFile(dir, "2030")).toThrow(/Unknown trajectory ID '2030'/);
  });

  test("HERAV1TOOL-TP01-TC-31 ranking, chronological on empty query, 50 cap, corrupt line skipped, SearchType user error", async () => {
    const dir = sessions();
    const ctx = toolCtx({ sessionsDir: dir });
    const ranked = await trajectorySearch({ ID: "2026-01-15_100000", Query: "parser module", SearchType: "conversation" }, ctx);
    const blocks = ranked.text.split("\n\n");
    expect(blocks[0]).toContain("2 chunks from '2026-01-15_100000_abcd.jsonl' for 'parser module' (sorted by relevance); 1 corrupt line skipped:");
    expect(blocks[1]).toContain("user_message (score 1.00)");
    expect(blocks[2]).toContain("text_delta (score 0.50)");
    const all = await trajectorySearch({ ID: "2026-01-15_100000", Query: "", SearchType: "conversation" }, ctx);
    const chunks = all.text.split("\n\n").slice(1);
    expect(chunks).toHaveLength(50);
    expect(chunks[0]).toContain("[line 1]");
    expect(chunks[1]).toContain("[line 2]");
    expect(chunks[2]).toContain("[line 4]");
    expect(all.text).toContain("(chronological)");
    expect(await toolError(() => trajectorySearch({ ID: "2026-01-16", Query: "x", SearchType: "user" }, ctx))).toContain("SearchType 'user' is not supported");
    const none = await trajectorySearch({ ID: "2026-01-16", Query: "zzz", SearchType: "conversation" }, ctx);
    expect(none.text).toContain("No matching chunks");
  });

  test("HERAV1HRNS-TP01-TC-06c trajectory_search scoped by run_ctx returns nothing from another run_ctx", async () => {
    const dir = makeTempDir("traj_rctx");
    dirs.push(dir);
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir);
    const eventA = { ts: nowTs(), proc: "exec", type: "text_delta", text: "work in run A", run_ctx: "run_a" } as AgentEvent;
    const eventB = { ts: nowTs(), proc: "exec", type: "text_delta", text: "work in run B", run_ctx: "run_b" } as AgentEvent;
    writeFileSync(join(sessionsDir, "2026-01-20_100000_aaaa.jsonl"), `${toJsonl(eventA)}\n${toJsonl(eventB)}\n`);
    const ctxA = toolCtx({ sessionsDir: sessionsDir, runCtx: "run_a" });
    const resultA = await trajectorySearch({ ID: "2026-01-20_100000", Query: "", SearchType: "conversation" }, ctxA);
    const chunksA = resultA.text.split("\n\n").slice(1);
    expect(chunksA).toHaveLength(1);
    expect(chunksA[0]).toContain("work in run A");
    expect(chunksA[0]).not.toContain("work in run B");
    const ctxB = toolCtx({ sessionsDir: sessionsDir, runCtx: "run_b" });
    const resultB = await trajectorySearch({ ID: "2026-01-20_100000", Query: "", SearchType: "conversation" }, ctxB);
    const chunksB = resultB.text.split("\n\n").slice(1);
    expect(chunksB).toHaveLength(1);
    expect(chunksB[0]).toContain("work in run B");
    expect(chunksB[0]).not.toContain("work in run A");
    const ctxNoFilter = toolCtx({ sessionsDir: sessionsDir });
    const resultAll = await trajectorySearch({ ID: "2026-01-20_100000", Query: "", SearchType: "conversation" }, ctxNoFilter);
    const chunksAll = resultAll.text.split("\n\n").slice(1);
    expect(chunksAll).toHaveLength(2);
  });

  test("HERAV1TOOL-TP01-TC-32 todo_list replace and echo; duplicate id error", async () => {
    const ctx = toolCtx();
    const r = await todoList({ todos: [{ id: "1", content: "a", status: "pending", priority: "high" }, { id: "2", content: "b", status: "completed", priority: "low" }] }, ctx);
    expect(ctx.state.todo).toHaveLength(2);
    expect(JSON.parse(r.text)).toEqual({ todos: ctx.state.todo });
    await todoList({ todos: [{ id: "9", content: "c", status: "in_progress", priority: "medium" }] }, ctx);
    expect(ctx.state.todo.map((t) => t.id)).toEqual(["9"]);
    expect(await toolError(() => todoList({ todos: [{ id: "x", content: "a", status: "pending", priority: "high" }, { id: "x", content: "b", status: "pending", priority: "high" }] }, ctx))).toContain("duplicate id 'x'");
    expect(ctx.state.todo.map((t) => t.id)).toEqual(["9"]);
  });

  test("HERAV1TOOL-TP01-TC-33 skill body plus sorted supporting files; unknown and wrong case → error listing names", async () => {
    const ctx = toolCtx();
    ctx.promptSystem = loadPromptSystem(join(REPO_ROOT, "tests", "fixtures", "fake_system"));
    const r = await skill({ SkillName: "sample-skill" }, ctx);
    expect(r.text).toContain("# Sample Skill");
    expect(r.text).toContain("Supporting files (relative to ");
    expect(r.text).toContain("- references/CHECKS.md\n- references/GUIDE.md");
    const plain = await skill({ SkillName: "plain-skill" }, ctx);
    expect(plain.text).not.toContain("Supporting files");
    expect(await toolError(() => skill({ SkillName: "Sample-Skill" }, ctx))).toBe("Unknown skill 'Sample-Skill'. Available skills: plain-skill, sample-skill. Use one of the listed names (case-sensitive).");
    expect(await toolError(() => skill({ SkillName: "x" }, toolCtx()))).toContain("Available skills: (none)");
  });

  test("HERAV1TOOL-TP01-TC-34 askUser selections, free text, fallback returned unchanged", async () => {
    const seen: unknown[] = [];
    const ctx = toolCtx({
      askUser: (req) => {
        seen.push(req);
        if (req.allowMultiple) return Promise.resolve({ selected: ["A", "B"] });
        if (req.question.startsWith("free")) return Promise.resolve({ text: "  my own answer  " });
        return Promise.resolve({ selected: ["B"] });
      },
    });
    const multi = await askUserQuestion({ question: "pick", options: [{ label: "A", description: "a" }, { label: "B" }], allowMultiple: true }, ctx);
    expect(multi.text).toBe("A\nB");
    expect(seen[0]).toEqual({ question: "pick", options: [{ label: "A", description: "a" }, { label: "B" }], allowMultiple: true });
    const single = await askUserQuestion({ question: "pick", options: [{ label: "A" }, { label: "B" }] }, ctx);
    expect(single.text).toBe("B");
    const free = await askUserQuestion({ question: "free form?", options: [{ label: "A" }] }, ctx);
    expect(free.text).toBe("  my own answer  ");
  });

  test("HERAV1TOOL-TP01-TC-35 option count bounds; rejection on cancel → cancelled", async () => {
    const ctx = toolCtx({ askUser: () => Promise.resolve({ text: "x" }) });
    const defs = buildDefinitions({ os: "windows", shell: "pwsh", skills: [] });
    const registry = createToolRegistry(defs);
    const tooMany = await registry.dispatch(call("ask_user_question", { question: "q", options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}`, description: "d" })), allowMultiple: false }), ctx);
    expect(tooMany.status).toBe("error");
    expect(tooMany.text).toContain("5 options given; provide 1 to 4");
    const none = await registry.dispatch(call("ask_user_question", { question: "q", options: [], allowMultiple: false }), ctx);
    expect(none.text).toContain("provide 1 to 4");
    const controller = new AbortController();
    const cancelling = toolCtx({
      signal: controller.signal,
      askUser: () =>
        new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("cancelled by user")), { once: true });
        }),
    });
    const pending = askUserQuestion({ question: "q", options: [{ label: "A" }] }, cancelling);
    controller.abort();
    const r = await pending;
    expect(r.status).toBe("cancelled");
    expect(registry.names()).toHaveLength(15);
  });
});
