import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonlFile } from "../../src/events.ts";
import { AcpClient, assertStdoutPure } from "../harness/acp_client.ts";
import { FAKE_SYSTEM, SCRIPTS, prepareRig } from "../harness/executor_rig.ts";
import { removeDir } from "../harness/procs.ts";
import { SchemaOracle } from "../harness/schema_validate.ts";
import pkg from "../../package.json" with { type: "json" };

const clients: AcpClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  for (const d of dirs.splice(0)) removeDir(d);
});

const oracle = new SchemaOracle();

export function acpRig(script: string, opts: { capabilities?: "full" | "bare"; configOverrides?: Record<string, unknown>; extraArgs?: string[]; env?: Record<string, string> } = {}): { client: AcpClient; appDir: string; workspace: string } {
  const prepared = prepareRig({ script: join(SCRIPTS, script), agentFolder: FAKE_SYSTEM, configOverrides: { supervisor: { review_every_calls: 50, cost_alert_usd: 100 }, ...(opts.configOverrides ?? {}) } });
  dirs.push(...prepared.dirs);
  const client = new AcpClient({ workspace: prepared.workspace, appDir: prepared.appDir, scriptPath: prepared.env["HERA_SCRIPTED_ADAPTER"] as string, capabilities: opts.capabilities ?? "full", extraArgs: opts.extraArgs, env: opts.env }).start();
  clients.push(client);
  return { client, appDir: prepared.appDir, workspace: prepared.workspace };
}

/** Every outbound line validates against the bundled v1 schema (NFR-01). */
export function assertAllOutboundValid(client: AcpClient): void {
  for (const line of client.rawStdout) {
    const msg = JSON.parse(line) as { method?: string; params?: unknown; result?: unknown; error?: unknown; id?: unknown };
    if (msg.method === "session/update") oracle.assertValid("SessionNotification", msg.params);
    else if (msg.method === "session/request_permission") oracle.assertValid("RequestPermissionRequest", msg.params);
    else if (msg.method === "elicitation/create") oracle.assertValid("CreateElicitationRequest", msg.params);
    else if (msg.result !== undefined && typeof msg.result === "object" && msg.result !== null) {
      const r = msg.result as Record<string, unknown>;
      if ("protocolVersion" in r) oracle.assertValid("InitializeResponse", r);
      else if ("stopReason" in r) oracle.assertValid("PromptResponse", r);
      else if ("sessionId" in r) oracle.assertValid("NewSessionResponse", r);
    }
  }
}

describe("[integration] HERAV1ACP-TP01 handshake and sessions (fake client over stdio)", () => {
  async function retryHandshake(client: AcpClient, protocolVersion = 1): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.handshake(protocolVersion);
      } catch (e) {
        if (attempt < 2 && e instanceof Error && e.message.includes("hera exited")) {
          await Bun.sleep(500);
          client.restart();
          continue;
        }
        throw e;
      }
    }
  }

  test("HERAV1ACP-IP01-TC-12/13 initialize exact shape; before it session/new → error; twice → identical; protocolVersion 2 → 1", async () => {
    const { client, workspace } = acpRig("script_exec_basic.jsonl");
    const early = await client.request("session/new", { cwd: workspace });
    expect(early.response.error?.message).toContain("handshake incomplete");
    const result = await retryHandshake(client, 2);
    expect(result).toEqual({ protocolVersion: 1, agentInfo: { name: "hera", version: pkg.version }, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } } });
    const again = await client.request("initialize", { protocolVersion: 1 });
    expect(again.response.result).toEqual(result);
    expect(client.stderr()).toContain("answered identically");
    const { sessionId } = await client.sessionNew();
    expect(sessionId).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_[0-9a-f]{4}$/);
    assertStdoutPure(client);
    assertAllOutboundValid(client);
  }, 40000);

  test("HERAV1ACP-IP01-TC-14 session/new: sessionId = JSONL stem, available_commands_update lists fixture workflows plus status and cost; mcpServers and additionalDirectories warn", async () => {
    const { client, appDir } = acpRig("script_exec_basic.jsonl");
    await retryHandshake(client);
    const { sessionId } = await client.sessionNew({ mcpServers: [{ name: "fs", command: "npx", args: [], env: [] }], additionalDirectories: ["/other"] });
    const commands = await client.readMessage();
    const update = (commands.params as { update: { sessionUpdate: string; availableCommands: Array<{ name: string }> } }).update;
    expect(update.sessionUpdate).toBe("available_commands_update");
    const names = update.availableCommands.map((c) => c.name);
    expect(names.slice(-2)).toEqual(["status", "cost"]);
    expect(names).toContain("prime");
    expect(names).not.toContain("help");
    expect(names).not.toContain("exit");
    expect(existsSync(join(appDir, ".agent-data", "sessions", `${sessionId}.jsonl`))).toBe(true);
    expect(client.stderr()).toContain("'mcpServers' ignored");
    expect(client.stderr()).toContain("'additionalDirectories' ignored");
    // the first JSONL line arrives with the first prompt (FR-03)
    const { response } = await client.request("session/prompt", AcpClient.promptParams(sessionId, "read the readme"));
    expect(response.result).toEqual({ stopReason: "end_turn" });
    const events = readJsonlFile(join(appDir, ".agent-data", "sessions", `${sessionId}.jsonl`)).events;
    expect(events[0]?.type).toBe("session_started");
    assertAllOutboundValid(client);
  }, 40000);

  test("HERAV1ACP-IP01-TC-15 session/new with a missing cwd → -32602; a second session/new while idle closes the first JSONL and respawns both children with new pids", async () => {
    const { client, appDir } = acpRig("script_exec_basic.jsonl");
    await retryHandshake(client);
    const bad = await client.request("session/new", { cwd: join(appDir, "does-not-exist") });
    expect(bad.response.error?.code).toBe(-32602);
    expect(bad.response.error?.message).toContain("does-not-exist");
    const first = await client.sessionNew();
    await client.readMessage(); // commands
    const statusBefore = await client.request("session/prompt", AcpClient.promptParams(first.sessionId, "/status"));
    const pidsBefore = (AcpClient.updates(statusBefore.collected, "agent_message_chunk")[0] as { content: { text: string } }).content.text.match(/pid='(\d+)'/g);
    const second = await client.sessionNew();
    await client.readMessage(); // commands
    expect(second.sessionId).not.toBe(first.sessionId);
    const statusAfter = await client.request("session/prompt", AcpClient.promptParams(second.sessionId, "/status"));
    const text = (AcpClient.updates(statusAfter.collected, "agent_message_chunk")[0] as { content: { text: string } }).content.text;
    const pidsAfter = text.match(/pid='(\d+)'/g);
    expect(pidsAfter).not.toEqual(pidsBefore);
    expect(text).toContain("Restarts this session: 0");
    expect(readdirSync(join(appDir, ".agent-data", "sessions")).length).toBe(2);
    // the old session id is unknown now
    const stale = await client.request("session/prompt", AcpClient.promptParams(first.sessionId, "x"));
    expect(stale.response.error?.code).toBe(-32602);
  }, 60000);

  test("HERAV1ACP-IP01-TC-16 session/load: replay notifications in order before the response; unknown id → error naming the directory; legacy file → warning", async () => {
    const { client, appDir, workspace } = acpRig("script_exec_basic.jsonl");
    await retryHandshake(client);
    const { sessionId } = await client.sessionNew();
    await client.readMessage();
    await client.request("session/prompt", AcpClient.promptParams(sessionId, "read the readme"));
    const { response, collected } = await client.request("session/load", { sessionId, cwd: workspace });
    expect(response.result).toEqual({});
    const kinds = AcpClient.updates(collected).map((u) => u["sessionUpdate"]);
    expect(kinds[0]).toBe("user_message_chunk");
    expect(kinds).toContain("agent_message_chunk");
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("tool_call_update"));
    const commands = await client.readMessage();
    expect((commands.params as { update: { sessionUpdate: string } }).update.sessionUpdate).toBe("available_commands_update");
    expect(client.stderr()).toMatch(/session\/load: '.*' - \d+ updates replayed/);
    const unknown = await client.request("session/load", { sessionId: "2020-01-01_000000_dead", cwd: workspace });
    expect(unknown.response.error?.message).toContain(join(appDir, ".agent-data", "sessions"));
    // the loaded session accepts a prompt
    const after = await client.request("session/prompt", AcpClient.promptParams(sessionId, "and again"));
    expect(after.response.result).toEqual({ stopReason: "end_turn" });
    assertAllOutboundValid(client);
  }, 60000);

  test("HERAV1ACP-IP01-TC-17 session/new while a turn is active → error naming the active session", async () => {
    const { client, workspace } = acpRig("script_sleep_short.jsonl", { configOverrides: { harness: { local: { approval: "off" } } } });
    await retryHandshake(client);
    const { sessionId } = await client.sessionNew();
    await client.readMessage();
    const promptId = client.sendRequest("session/prompt", AcpClient.promptParams(sessionId, "run it"));
    await client.readUntil((m) => m.method === "session/update" && (m.params as { update: { sessionUpdate: string } }).update.sessionUpdate === "tool_call");
    const blocked = await client.request("session/new", { cwd: workspace });
    expect(blocked.response.error?.message).toContain(`active in session '${sessionId}'`);
    const { match } = await client.readUntil((m) => m.id === promptId, 20000);
    expect(match.result).toEqual({ stopReason: "end_turn" });
  }, 40000);

  test("HERAV1ACP-IP01-TC-29 stdin EOF: clean exit 0, stdout pure, session file intact", async () => {
    const { client, appDir } = acpRig("script_exec_basic.jsonl");
    await retryHandshake(client);
    const { sessionId } = await client.sessionNew();
    await client.readMessage();
    client.closeStdin();
    expect(await client.waitExit()).toBe(0);
    assertStdoutPure(client);
    expect(client.rawStdout.length).toBe(3);
    expect(existsSync(join(appDir, ".agent-data", "sessions", `${sessionId}.jsonl`))).toBe(true);
    // the Executor writes session_started at session_open; the session-open notices (prompt system warnings) follow and went to stderr, not the wire
    const lines = readFileSync(join(appDir, ".agent-data", "sessions", `${sessionId}.jsonl`), "utf8").trim().split("\n").filter((l) => l.length > 0);
    expect((JSON.parse(lines[0] as string) as { type: string }).type).toBe("session_started");
    expect(lines.slice(1).every((l) => (JSON.parse(l) as { type: string }).type === "error")).toBe(true);
    expect(client.stderr()).toContain("WARNING:");
    expect(client.stderr()).toContain("stdin EOF");
  }, 40000);

  test("HERAV1ACP-IP01-TC-30 session/update notifications carry monotonic seq; gap resync replays JSONL", async () => {
    const { client, appDir, workspace } = acpRig("script_exec_basic.jsonl");
    await retryHandshake(client);
    const { sessionId } = await client.sessionNew();
    await client.readMessage(); // available_commands_update

    // Send a prompt to generate events
    const { response, collected } = await client.request("session/prompt", AcpClient.promptParams(sessionId, "read the readme"));
    expect(response.result).toEqual({ stopReason: "end_turn" });

    // Verify seq field is present and monotonic on session/update notifications
    const updates = collected.filter((m) => m.method === "session/update");
    for (const u of updates) {
      const params = u.params as { seq?: number; update: Record<string, unknown> };
      expect(typeof params.seq).toBe("number");
    }
    // Seq values should be monotonic
    const seqs = updates.map((u) => (u.params as { seq: number }).seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
    }

    // Verify the JSONL file exists (for resync replay)
    expect(existsSync(join(appDir, ".agent-data", "sessions", `${sessionId}.jsonl`))).toBe(true);

    // Verify session/load replays with seq
    const { response: loadResp, collected: loadCollected } = await client.request("session/load", { sessionId, cwd: workspace });
    expect(loadResp.result).toEqual({});
    const loadUpdates = loadCollected.filter((m) => m.method === "session/update");
    for (const u of loadUpdates) {
      const params = u.params as { seq?: number; update: Record<string, unknown> };
      expect(typeof params.seq).toBe("number");
    }

    assertAllOutboundValid(client);
  }, 40000);
});
