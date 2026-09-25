// Web tools: search_web, read_url_content, view_content_chunk (HERAV1TOOL-SP01 FR-04; HERAV1TOOL-IP01 IS-06).
// Port of V1 web_tools.py without the approval gate (Turbo, spec 05 DD-07); the fetched host is recorded in meta.

import { ToolError } from "../errors.ts";
import type { WebSearchResult } from "../providers/base.ts";
import type { ToolContext, ToolResult } from "./registry.ts";
import { EffectDescriptor } from "../harness/descriptor.ts";

export const FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const CHUNK_CHARS = 8000;
export const FETCH_DEADLINE_MS = 120_000;
export const MAX_REDIRECTS = 5;
const TEXT_MARKERS = ["text/", "application/json", "application/xml", "application/xhtml", "application/javascript", "application/x-ndjson"];

/** Per-Executor document store (view_content_chunk needs the chunks of this lifetime only). */
export class DocumentStore {
  private readonly docs = new Map<string, { url: string; chunks: string[] }>();
  private counter = 0;

  add(url: string, chunks: string[]): string {
    this.counter++;
    const id = `doc_${String(this.counter).padStart(4, "0")}`;
    this.docs.set(id, { url, chunks });
    return id;
  }

  get(id: string): { url: string; chunks: string[] } | undefined {
    return this.docs.get(id);
  }

  ids(): string[] {
    return [...this.docs.keys()];
  }
}

const stores = new WeakMap<ToolContext, DocumentStore>();

export function documentStoreOf(ctx: ToolContext): DocumentStore {
  let store = stores.get(ctx);
  if (store === undefined) {
    store = new DocumentStore();
    stores.set(ctx, store);
  }
  return store;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strip script/style/head/svg/noscript, turn tags into whitespace, decode entities, collapse whitespace. */
export function htmlToText(raw: string): string {
  let text = raw.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<(script|style|noscript|head|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  text = text.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

export function chunkText(text: string, size: number = CHUNK_CHARS): string[] {
  if (text.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function renderSearchResults(results: WebSearchResult[]): string {
  const lines = results.slice(0, 5).map((r) => `- ${r.title.length > 0 ? r.title : "(no title)"}\n  ${r.url}\n  ${r.snippet.slice(0, 300)}`);
  lines.push("\nUse read_url_content on a result URL to read further.");
  return lines.join("\n");
}

export async function searchWeb(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const adapter = ctx.adapters.websearch;
  const role = ctx.adapters.websearchRole;
  if (adapter === undefined || role === undefined) throw new ToolError("search_web unavailable -> no 'websearch' role configured in agent-config.json.", "Configure roles.websearch or roles.compacting.");
  if (!adapter.supportsWebSearch()) throw new ToolError(`search_web unavailable -> provider adapter for '${role.modelId}' has no web search support. Configure a different websearch model (EC-19).`, "Change roles.websearch to a provider with web search.");
  const query = String(args["query"]);
  const domain = typeof args["domain"] === "string" && args["domain"].length > 0 ? args["domain"] : undefined;
  const results = await adapter.webSearch(domain !== undefined ? `${query} (restrict to site ${domain})` : query, role, ctx.signal);
  return { status: "ok", text: renderSearchResults(results) };
}

let netEgressCounter = 0;

/** Wraps fetch() through the gate as net.egress (H-01). */
async function egressFetch(ctx: ToolContext, url: string, init: RequestInit): Promise<Response> {
  const gate = ctx.gate;
  if (gate === undefined) return fetch(url, init);
  const descriptor = new EffectDescriptor({
    effect_id: `fx_net_${++netEgressCounter}`,
    kind: "net.egress",
    target: url,
    parameters: { url },
  });
  let response: Response | undefined;
  const result = await gate.egress(descriptor, async () => {
    response = await fetch(url, init);
    return { status: "ok" as const, text: "fetched" };
  });
  if (result.status === "blocked") throw new ToolError(`Cannot fetch '${url}': ${result.text}`, "The gate blocked this request.");
  if (response === undefined) throw new ToolError(`Cannot fetch '${url}': gate returned no response`, "Internal error.");
  return response;
}

export async function readUrlContent(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = String(args["Url"]);
  if (!/^https?:\/\//i.test(url)) throw new ToolError(`URL must be HTTP or HTTPS: '${url}'`, "Include the scheme.");
  const deadlineMs = ctx.timeouts?.fetchMs ?? FETCH_DEADLINE_MS;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("deadline")), deadlineMs);
  const started = performance.now();
  let host = "";
  try {
    host = new URL(url).host;
    let response: Response;
    try {
      response = await egressFetch(ctx, url, { signal: controller.signal, redirect: "manual", headers: { "User-Agent": "Hera" } });
      let redirects = 0;
      let current = url;
      while (response.status >= 300 && response.status < 400 && response.headers.get("location") !== null) {
        redirects++;
        if (redirects > MAX_REDIRECTS) throw new ToolError(`Cannot fetch '${url}': more than ${MAX_REDIRECTS} redirects.`, "Use the final URL directly.");
        current = new URL(response.headers.get("location") as string, current).toString();
        response = await egressFetch(ctx, current, { signal: controller.signal, redirect: "manual", headers: { "User-Agent": "Hera" } });
      }
      host = new URL(current).host;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (controller.signal.aborted && !ctx.signal.aborted) throw new ToolError(`Fetch of '${url}' aborted after ${Math.round(deadlineMs / 1000)} s wall-clock deadline - the server is too slow.`, "Try again later or fetch a smaller resource.");
      throw new ToolError(`Cannot fetch '${url}': ${error instanceof Error ? error.message : String(error)}`, "Check the URL and the network.");
    }
    if (!response.ok) throw new ToolError(`Cannot fetch '${url}': HTTP ${response.status}${response.statusText.length > 0 ? ` ${response.statusText}` : ""}.`, "Check the URL.");
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.length > 0 && !TEXT_MARKERS.some((m) => contentType.toLowerCase().includes(m))) throw new ToolError(`Refused non-text content from '${url}': Content-Type '${contentType}'.`, "read_url_content reads text resources only.");
    const parts: Uint8Array[] = [];
    let received = 0;
    const body = response.body;
    if (body === null) throw new ToolError(`Cannot fetch '${url}': empty response body.`, "Check the URL.");
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          parts.push(value);
          received += value.byteLength;
        }
        if (received > FETCH_MAX_BYTES) throw new ToolError(`Refused '${url}': body exceeds ${FETCH_MAX_BYTES / (1024 * 1024)} MB.`, "Fetch a smaller resource.");
        if (performance.now() - started > deadlineMs) throw new ToolError(`Fetch of '${url}' aborted after ${Math.round(deadlineMs / 1000)} s wall-clock deadline (${received} bytes received) - the server is too slow.`, "Try again later or fetch a smaller resource.");
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (controller.signal.aborted && !ctx.signal.aborted) throw new ToolError(`Fetch of '${url}' aborted after ${Math.round(deadlineMs / 1000)} s wall-clock deadline (${received} bytes received) - the server is too slow.`, "Try again later or fetch a smaller resource.");
      throw new ToolError(`Cannot fetch '${url}': ${error instanceof Error ? error.message : String(error)}`, "Check the URL and the network.");
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const p of parts) {
      bytes.set(p, offset);
      offset += p.byteLength;
    }
    if (bytes.subarray(0, 1024).includes(0)) throw new ToolError(`Refused binary content from '${url}'.`, "read_url_content reads text resources only.");
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
    const isHtml = contentType.toLowerCase().includes("text/html") || /<html\b/i.test(raw.slice(0, 2000));
    const text = isHtml ? htmlToText(raw) : raw;
    const chunks = chunkText(text);
    const id = documentStoreOf(ctx).add(url, chunks);
    const total = chunks.length;
    const header = `Document '${id}' fetched from ${url}: ${total} chunk${total === 1 ? "" : "s"} of up to ${CHUNK_CHARS} chars. Use view_content_chunk with positions 1..${total} for more.\n\n`;
    return { status: "ok", text: `${header}[chunk 1 of ${total}]\n${chunks[0] ?? ""}`, meta: { host } };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

export async function viewContentChunk(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const store = documentStoreOf(ctx);
  const id = String(args["document_id"]);
  const position = Number(args["position"]);
  const doc = store.get(id);
  if (doc === undefined) throw new ToolError(`Unknown document_id '${id}'. Fetch the URL with read_url_content first. Known ids: ${store.ids().join(", ") || "(none)"}`, "Call read_url_content first.");
  if (!Number.isInteger(position) || position < 1 || position > doc.chunks.length) throw new ToolError(`Position ${position} out of range for '${id}': valid range is 1..${doc.chunks.length}.`, "Use a position inside the range.");
  await Promise.resolve();
  return { status: "ok", text: `[chunk ${position} of ${doc.chunks.length}]\n${doc.chunks[position - 1] ?? ""}`, meta: { host: new URL(doc.url).host } };
}
