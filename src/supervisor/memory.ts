// Memory store, extraction, retrieval (HERAV1SUPV-SP01 FR-05, IG-04; HERAV1SUPV-IP01 IS-05). Append-only JSONL per
// scope under data_dir/memories/; the Memory model extracts at turn end and ranks at turn start; the Supervisor injects.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ResolvedRole } from "../config/load.ts";
import { nowTs } from "../events.ts";
import type { Usage } from "../models.ts";
import type { ProviderAdapter } from "../providers/base.ts";
import { redactKeyShapes, scanKeyShapes } from "../harness/plugs/keyshapes.ts";
import { egressModelInvoke } from "../providers/registry.ts";
import { Gate } from "../harness/gate.ts";
import { EffectDescriptor } from "../harness/descriptor.ts";
import type { EmitFn } from "../harness/sink.ts";
import { computeMac, migrateMemoryFile } from "../config/migrate.ts";

export type MemoryScope = "workspace" | "global";

export interface Memory {
  id: string;
  text: string;
  scope: MemoryScope;
  tags: string[];
  created: string;
  last_used: string;
  uses: number;
  source_session: string;
  origin?: { kind: string; ref: string | string[] };
  mac?: string;
  migrated?: boolean;
}

export interface Tombstone {
  id: string;
  deleted: true;
  ts: string;
  reason: string;
  mac?: string;
  migrated?: boolean;
}

export type MemoryLine = Memory | Tombstone;

export const MEMORY_TEXT_MAX = 500;
export const MAX_CANDIDATES = 60;
export const TRIVIAL_TEXT_CHARS = 200;

export const EXTRACT_SYSTEM_PROMPT = `You extract durable memories from one finished turn of a coding agent.
Return a JSON array of 0 to 3 objects {"text": string, "scope": "workspace" | "global", "tags": string[]}.
A memory is a stable fact or preference useful in later sessions (project conventions, user preferences, decisions).
Never include secrets, API keys, tool output, or file contents beyond paths. Each text under 400 characters.
Return [] when nothing durable was learned.`;

export const RETRIEVE_SYSTEM_PROMPT = `You rank stored memories by relevance to a new user request.
Return a JSON array with the ids of the relevant memories, most relevant first, at most the requested count. Return [] when none apply.`;

export function workspaceHash(workspace: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(workspace.replace(/\\/g, "/").toLowerCase());
  return hasher.digest("hex").slice(0, 12);
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface MemoryStoreOptions {
  gate?: Gate;
  runCtx?: string;
  retentionDays?: number;
  secretPath?: string;
}

export class MemoryStore {
  readonly memories = new Map<string, Memory>();
  readonly warnings: string[] = [];
  private counter = 0;
  private memEgressCounter = 0;
  readonly runCtx: string | undefined;
  readonly retentionDays: number;
  private readonly lockPath: string;

  private constructor(
    readonly dir: string,
    readonly workspaceFile: string,
    readonly globalFile: string,
    opts: MemoryStoreOptions,
  ) {
    this.gate = opts.gate;
    this.runCtx = opts.runCtx;
    this.retentionDays = opts.retentionDays ?? 0;
    this.lockPath = join(dir, ".memory.lock");
    this.secretPath = opts.secretPath;
  }

  private gate?: Gate;
  private secret: Buffer | undefined;
  private readonly secretPath: string | undefined;

  static open(dir: string, hash: string, opts?: MemoryStoreOptions | Gate): MemoryStore {
    mkdirSync(dir, { recursive: true });
    const resolved: MemoryStoreOptions = opts instanceof Gate ? { gate: opts } : (opts ?? {});
    const store = new MemoryStore(dir, join(dir, `workspace-${hash}.jsonl`), join(dir, "global.jsonl"), resolved);
    if (store.secretPath !== undefined) {
      store.secret = store.loadOrCreateSecret();
      if (store.secret.length > 0) {
        migrateMemoryFile(store.globalFile, store.secret);
        migrateMemoryFile(store.workspaceFile, store.secret);
      }
    }
    store.fold(store.globalFile);
    store.fold(store.workspaceFile);
    if (store.retentionDays > 0) store.applyRetention();
    return store;
  }

  /** U12: Load existing secret or create a new 32-byte random secret. */
  private loadOrCreateSecret(): Buffer {
    const p = this.secretPath!;
    if (existsSync(p)) {
      const hex = readFileSync(p, "utf8").trim();
      if (hex.length > 0) return Buffer.from(hex, "hex");
    }
    const secret = randomBytes(32);
    try {
      writeFileSync(p, secret.toString("hex"), { mode: 0o600 });
    } catch {
      writeFileSync(p, secret.toString("hex"));
    }
    return secret;
  }

  /** U12: Compute MAC for a line, adding it to the output. */
  private tagLine<T extends MemoryLine>(line: T): T & { mac: string } {
    const { mac: _, ...rest } = line as unknown as Record<string, unknown>;
    return { ...line, mac: computeMac(rest, this.secret!) } as T & { mac: string };
  }

  /** Latest line per id wins; tombstones remove; corrupt lines are skipped with one warning each. U12: MAC verified. */
  private fold(file: string): void {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    let macFailures = 0;
    for (const [i, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      let parsed: MemoryLine;
      try {
        parsed = JSON.parse(line) as MemoryLine;
        if (typeof parsed !== "object" || parsed === null || typeof parsed.id !== "string") throw new Error("not a memory line");
      } catch (error) {
        this.warnings.push(`WARNING: memory file '${file}' line ${i + 1} skipped: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (this.secret !== undefined) {
        const { mac, ...rest } = parsed as unknown as Record<string, unknown>;
        if (typeof mac !== "string" || computeMac(rest, this.secret) !== mac) {
          macFailures++;
          continue;
        }
      }
      if ("deleted" in parsed && parsed.deleted === true) this.memories.delete(parsed.id);
      else this.memories.set(parsed.id, parsed as Memory);
      const n = Number(/^mem_(\d+)/.exec(parsed.id)?.[1] ?? 0);
      if (n > this.counter) this.counter = n;
    }
    if (macFailures > 0) {
      this.warnings.push(`WARNING: ${macFailures} memory lines failed integrity check and were skipped`);
    }
  }

  private fileFor(scope: MemoryScope): string {
    return scope === "global" ? this.globalFile : this.workspaceFile;
  }

  newId(): string {
    this.counter++;
    return `mem_${String(this.counter).padStart(5, "0")}`;
  }

  private acquireLock(timeoutMs = 5000): void {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        writeFileSync(this.lockPath, String(process.pid), { flag: "wx" });
        return;
      } catch (e) {
        const err = e as { code?: string };
        if (err.code === "EEXIST") {
          try {
            const lockPid = Number(readFileSync(this.lockPath, "utf8").trim());
            process.kill(lockPid, 0);
          } catch {
            try { unlinkSync(this.lockPath); } catch { /* ignore */ }
            continue;
          }
          const target = Date.now() + 10;
          while (Date.now() < target) { /* brief spin wait */ }
          continue;
        }
        throw e;
      }
    }
    throw new Error(`memory store lock timeout after ${timeoutMs}ms at ${this.lockPath}`);
  }

  private releaseLock(): void {
    try { unlinkSync(this.lockPath); } catch { /* ignore */ }
  }

  append(line: MemoryLine): void {
    const scope = "deleted" in line ? (this.memories.get(line.id)?.scope ?? "workspace") : line.scope;
    const tagged = this.secret !== undefined ? this.tagLine(line) : line;
    this.acquireLock();
    try {
      appendFileSync(this.fileFor(scope), `${JSON.stringify(tagged)}\n`);
    } finally {
      this.releaseLock();
    }
    if ("deleted" in line) this.memories.delete(line.id);
    else this.memories.set(line.id, line);
  }

  async appendGated(line: MemoryLine, emit?: EmitFn): Promise<void> {
    if (this.gate === undefined) { this.append(line); return; }
    const scope = "deleted" in line ? (this.memories.get(line.id)?.scope ?? "workspace") : line.scope;
    const descriptor = new EffectDescriptor({
      effect_id: `fx_mem_${++this.memEgressCounter}`,
      kind: "memory.write",
      target: "memory_store",
      parameters: { id: line.id, scope },
    });
    const tagged = this.secret !== undefined ? this.tagLine(line) : line;
    const result = await this.gate.egress(descriptor, async () => {
      if (emit !== undefined) {
        await emit({ ts: nowTs(), proc: "sup", type: "memory_written", target: "memory_store", memory_id: line.id, scope }, true);
      }
      this.acquireLock();
      try {
        appendFileSync(this.fileFor(scope), `${JSON.stringify(tagged)}\n`);
      } finally {
        this.releaseLock();
      }
      return { status: "ok" as const, text: "written" };
    });
    if (result.status === "blocked") return;
    if ("deleted" in line) this.memories.delete(line.id);
    else this.memories.set(line.id, line);
  }

  /** A superseding line: same id, updated fields (last_used, uses). */
  touch(id: string, now: string): void {
    const m = this.memories.get(id);
    if (m === undefined) return;
    this.append({ ...m, last_used: now, uses: m.uses + 1 });
  }

  async touchGated(id: string, now: string, emit?: EmitFn): Promise<void> {
    const m = this.memories.get(id);
    if (m === undefined) return;
    await this.appendGated({ ...m, last_used: now, uses: m.uses + 1 }, emit);
  }

  findDuplicate(text: string): Memory | undefined {
    const n = normalizeText(text);
    for (const m of this.memories.values()) {
      const e = normalizeText(m.text);
      if (e === n || e.includes(n) || n.includes(e)) return m;
    }
    return undefined;
  }

  candidates(topK: number): Memory[] {
    const all = [...this.memories.values()];
    const workspace = all.filter((m) => m.scope === "workspace").sort((a, b) => b.last_used.localeCompare(a.last_used)).slice(0, topK * 4);
    const global = all.filter((m) => m.scope === "global");
    return [...workspace, ...global].slice(0, MAX_CANDIDATES);
  }

  /** Remove entries older than retentionDays; 0 = no retention limit. */
  private applyRetention(): void {
    if (this.retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - this.retentionDays * 86400000).toISOString();
    const expired: Memory[] = [];
    for (const m of this.memories.values()) {
      if (m.created < cutoff) expired.push(m);
    }
    for (const m of expired) {
      this.append({ id: m.id, deleted: true, ts: nowTs(), reason: `retention ${this.retentionDays}d` });
    }
  }

  get size(): number {
    return this.memories.size;
  }
}

export interface TurnSummary {
  userRequest: string;
  assistantText: string;
  toolNames: string[];
}

export function isTrivialTurn(turn: TurnSummary): boolean {
  return turn.toolNames.length === 0 && turn.assistantText.length < TRIVIAL_TEXT_CHARS;
}

export interface Candidate {
  text: string;
  scope: MemoryScope;
  tags: string[];
  origin?: { kind: string; ref: string | string[] };
}

/** Lenient JSON array extraction from model output (code fences and prose tolerated). */
export function parseJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Post-filter (IG-04): drop key-shaped tokens, cap length, coerce scope and tags. */
export function filterCandidates(raw: unknown[]): Candidate[] {
  const out: Candidate[] = [];
  for (const item of raw.slice(0, 3)) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec["text"] === "string" ? rec["text"].trim() : "";
    if (text.length === 0 || scanKeyShapes(text)) continue;
    const scope: MemoryScope = rec["scope"] === "global" ? "global" : "workspace";
    const tags = Array.isArray(rec["tags"]) ? (rec["tags"] as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 8) : [];
    out.push({ text: redactKeyShapes(text).slice(0, MEMORY_TEXT_MAX), scope, tags, ...(typeof rec["origin"] === "object" && rec["origin"] !== null ? { origin: rec["origin"] as { kind: string; ref: string | string[] } } : {}) });
  }
  return out;
}

export interface ModelCallResult {
  text: string;
  usage: Usage;
  request: string;
}

async function callModel(adapter: ProviderAdapter, role: ResolvedRole, system: string, request: string, gate: Gate | undefined, signal?: AbortSignal, emit?: EmitFn): Promise<ModelCallResult> {
  let text = "";
  let usage: Usage = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const stream = gate !== undefined ? egressModelInvoke(adapter, gate, { system, tools: [], messages: [{ role: "user", content: request }], role }, signal, emit) : adapter.streamTurn({ system, tools: [], messages: [{ role: "user", content: request }], role }, signal);
  for await (const delta of stream) {
    if (delta.kind === "text") text += delta.text;
    else if (delta.kind === "usage") usage = delta.usage;
  }
  return { text, usage, request };
}

export interface ExtractOutcome {
  created: Memory[];
  touched: string[];
  call: ModelCallResult | undefined;
}

export async function extractMemories(store: MemoryStore, turn: TurnSummary, adapter: ProviderAdapter, role: ResolvedRole, sessionId: string, gate: Gate | undefined, signal?: AbortSignal, emit?: EmitFn): Promise<ExtractOutcome> {
  if (isTrivialTurn(turn)) return { created: [], touched: [], call: undefined };
  const request = `User request:\n${turn.userRequest.slice(0, 2000)}\n\nAssistant text:\n${turn.assistantText.slice(0, 4000)}\n\nTools used: ${turn.toolNames.join(", ") || "(none)"}`;
  const call = await callModel(adapter, role, EXTRACT_SYSTEM_PROMPT, request, gate, signal, emit);
  const candidates = filterCandidates(parseJsonArray(call.text));
  const now = nowTs();
  const created: Memory[] = [];
  const touched: string[] = [];
  for (const c of candidates) {
    const dup = store.findDuplicate(c.text);
    if (dup !== undefined) {
      await store.touchGated(dup.id, now, emit);
      touched.push(dup.id);
      continue;
    }
    const memory: Memory = { id: store.newId(), text: c.text, scope: c.scope, tags: c.tags, created: now, last_used: now, uses: 0, source_session: sessionId, origin: c.origin ?? { kind: "model", ref: sessionId } };
    await store.appendGated(memory, emit);
    created.push(memory);
  }
  return { created, touched, call };
}

export interface RetrieveOutcome {
  selected: Memory[];
  call: ModelCallResult | undefined;
}

export async function retrieveMemories(store: MemoryStore, promptText: string, topK: number, adapter: ProviderAdapter, role: ResolvedRole, gate: Gate | undefined, signal?: AbortSignal, emit?: EmitFn): Promise<RetrieveOutcome> {
  const candidates = store.candidates(topK);
  if (candidates.length === 0) return { selected: [], call: undefined };
  const list = candidates.map((m) => `- ${m.id} [${m.scope}] ${m.text}`).join("\n");
  const request = `New user request:\n${promptText.slice(0, 2000)}\n\nStored memories (return at most ${topK} ids):\n${list}`;
  const call = await callModel(adapter, role, RETRIEVE_SYSTEM_PROMPT, request, gate, signal, emit);
  const ids = parseJsonArray(call.text).filter((x): x is string => typeof x === "string");
  const selected: Memory[] = [];
  const now = nowTs();
  for (const id of ids) {
    const m = store.memories.get(id);
    if (m === undefined || selected.some((s) => s.id === id)) continue;
    selected.push(m);
    if (selected.length >= topK) break;
  }
  for (const m of selected) await store.touchGated(m.id, now, emit);
  return { selected, call };
}
