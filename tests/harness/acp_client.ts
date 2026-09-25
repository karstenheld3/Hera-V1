// Fake ACP client driving the real `hera --acp` entrypoint over stdio (port of V1 tests/acp_harness.py; HERAV1ACP-TP01).
// Every stdout line is kept verbatim for the purity assertion (IG-01); agent-originated requests can be auto-answered.

import { heraCommand } from "./procs.ts";

export type JsonRpcMessage = Record<string, unknown> & { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };

export interface AcpClientOptions {
  workspace: string;
  appDir: string;
  scriptPath?: string;
  /** "full" = elicitation.form + url advertised; "bare" = none */
  capabilities?: "full" | "bare";
  env?: Record<string, string>;
  extraArgs?: string[];
}

const DEFAULT_TIMEOUT_MS = 30000;

export class AcpClient {
  private proc: BunSubprocess | undefined;
  readonly rawStdout: string[] = [];
  readonly transcript: Array<{ dir: "in" | "out"; msg: JsonRpcMessage }> = [];
  readonly autoResponders = new Map<string, (params: Record<string, unknown>) => unknown | undefined>();
  private readonly incoming: Array<JsonRpcMessage | { __unparseable__: string }> = [];
  private waiters: Array<() => void> = [];
  private stderrText = "";
  private nextId = 0;
  private exitCode: number | null | undefined;

  constructor(private readonly opts: AcpClientOptions) {}

  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, ...this.opts.env };
    delete env["OPENAI_API_KEY"];
    delete env["ANTHROPIC_API_KEY"];
    delete env["ZAI_API_KEY"];
    env["AGENT_APP_DIR"] = this.opts.appDir;
    if (this.opts.scriptPath !== undefined) env["HERA_SCRIPTED_ADAPTER"] = this.opts.scriptPath;
    else delete env["HERA_SCRIPTED_ADAPTER"];
    return env;
  }

  start(): this {
    const proc = Bun.spawn([...heraCommand(), "--acp", ...(this.opts.extraArgs ?? [])], { cwd: this.opts.workspace, env: this.env(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    void this.pump(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      if (line.length === 0) return;
      this.rawStdout.push(line);
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        this.transcript.push({ dir: "in", msg });
        this.incoming.push(msg);
      } catch {
        this.incoming.push({ __unparseable__: line });
      }
      this.wake();
    });
    void this.pump(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      this.stderrText += `${line}\n`;
    });
    void proc.exited.then((code) => {
      this.exitCode = code;
      this.wake();
    });
    return this;
  }

  private async pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? "";
      for (const p of parts) onLine(p);
    }
    if (pending.length > 0) onLine(pending);
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  get pid(): number {
    return this.proc?.pid ?? -1;
  }

  stderr(): string {
    return this.stderrText;
  }

  // ------------------------------------------------------------------ wire I/O

  sendRaw(line: string): void {
    const stdin = this.proc?.stdin as BunFileSink | undefined;
    if (stdin === undefined) throw new Error("client not started");
    stdin.write(`${line}\n`);
    void stdin.flush();
  }

  send(message: JsonRpcMessage): void {
    const msg = { jsonrpc: "2.0", ...message };
    this.transcript.push({ dir: "out", msg });
    this.sendRaw(JSON.stringify(msg));
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ method, params });
  }

  /** Sends a request without waiting; returns its id. */
  sendRequest(method: string, params: Record<string, unknown> = {}): number {
    const id = this.nextId++;
    this.send({ id, method, params });
    return id;
  }

  /** Next inbound message; auto-answers agent-originated requests with a registered responder. */
  async readMessage(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<JsonRpcMessage> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const next = this.incoming.shift();
      if (next !== undefined) {
        if ("__unparseable__" in next) throw new Error(`stdout line is not JSON: ${(next as { __unparseable__: string }).__unparseable__.slice(0, 120)}`);
        const msg = next as JsonRpcMessage;
        if (typeof msg.method === "string" && "id" in msg) {
          const responder = this.autoResponders.get(msg.method);
          if (responder !== undefined) {
            const result = responder(msg.params ?? {});
            if (result !== undefined) this.send({ id: msg.id, result });
          }
        }
        return msg;
      }
      if (this.exitCode !== undefined) throw new Error(`hera exited (code ${this.exitCode}) before the next message; stderr tail: ${this.stderrText.slice(-800)}`);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`no message within ${timeoutMs} ms; stderr tail: ${this.stderrText.slice(-800)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Reads until `pred` matches; returns the match and everything seen before it. */
  async readUntil(pred: (m: JsonRpcMessage) => boolean, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ match: JsonRpcMessage; seen: JsonRpcMessage[] }> {
    const deadline = performance.now() + timeoutMs;
    const seen: JsonRpcMessage[] = [];
    for (;;) {
      const msg = await this.readMessage(Math.max(50, deadline - performance.now()));
      if (pred(msg)) return { match: msg, seen };
      seen.push(msg);
      if (performance.now() > deadline) throw new Error(`predicate not met; saw ${seen.map((m) => m.method ?? `id ${String(m.id)}`).join(", ")}`);
    }
  }

  /** Sends a request and collects notifications and agent requests until the matching response. */
  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ response: JsonRpcMessage; collected: JsonRpcMessage[] }> {
    const id = this.sendRequest(method, params);
    const { match, seen } = await this.readUntil((m) => m.id === id && ("result" in m || "error" in m), timeoutMs);
    return { response: match, collected: seen };
  }

  // ------------------------------------------------------------------ protocol helpers

  async handshake(protocolVersion = 1): Promise<Record<string, unknown>> {
    const clientCapabilities = (this.opts.capabilities ?? "full") === "full" ? { elicitation: { form: {}, url: {} } } : {};
    const { response } = await this.request("initialize", { protocolVersion, clientInfo: { name: "acp-harness", version: "2.0" }, clientCapabilities });
    if (response.error !== undefined) throw new Error(`initialize failed: ${response.error.message}`);
    return response.result as Record<string, unknown>;
  }

  async sessionNew(extra: Record<string, unknown> = {}): Promise<{ sessionId: string; collected: JsonRpcMessage[] }> {
    const { response, collected } = await this.request("session/new", { cwd: this.opts.workspace, ...extra });
    if (response.error !== undefined) throw new Error(`session/new failed: ${response.error.message}`);
    return { sessionId: (response.result as { sessionId: string }).sessionId, collected };
  }

  static updates(collected: JsonRpcMessage[], kind?: string): Array<Record<string, unknown>> {
    const payloads = collected.filter((m) => m.method === "session/update").map((m) => (m.params as { update: Record<string, unknown> }).update);
    return kind === undefined ? payloads : payloads.filter((u) => u["sessionUpdate"] === kind);
  }

  static promptParams(sessionId: string, text = "do something"): Record<string, unknown> {
    return { sessionId, prompt: [{ type: "text", text }] };
  }

  closeStdin(): void {
    const stdin = this.proc?.stdin as BunFileSink | undefined;
    void stdin?.end();
  }

  async waitExit(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number | null> {
    if (this.proc === undefined) return null;
    const result = await Promise.race([this.proc.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs))]);
    return result === "timeout" ? null : result;
  }

  kill(): void {
    this.proc?.kill();
  }

  /** Teardown: EOF, wait, kill on timeout. */
  async stop(): Promise<number | null> {
    if (this.proc === undefined) return 0;
    try {
      this.closeStdin();
    } catch {
      /* already closed */
    }
    const code = await this.waitExit(15000);
    if (code === null) this.kill();
    return code;
  }

  /** Restart the process after a premature exit - resets all state and spawns a fresh process. */
  restart(): this {
    this.kill();
    this.proc = undefined;
    this.exitCode = undefined;
    this.rawStdout.length = 0;
    this.transcript.length = 0;
    this.incoming.length = 0;
    this.waiters.length = 0;
    this.stderrText = "";
    this.nextId = 0;
    return this.start();
  }
}

/** IG-01: every stdout line is a valid JSON-RPC 2.0 message. */
export function assertStdoutPure(client: AcpClient): void {
  for (const line of client.rawStdout) {
    const parsed = JSON.parse(line) as { jsonrpc?: string };
    if (parsed.jsonrpc !== "2.0") throw new Error(`stdout line is JSON but not JSON-RPC 2.0: ${line.slice(0, 120)}`);
  }
}
