// Retry policy (HERAV1PRVD-SP01 FR-06; HERAV1PRVD-IP01 IS-02): at most 2 Hera-owned retries (2 s, 8 s or Retry-After
// capped at 30 s) on retryable failures that occur before the first streamed delta; each retry announced as a notice.

import { ProviderError } from "../errors.ts";
import type { ProviderId } from "../models.ts";
import { providerDisplayName } from "./base.ts";
import { redactKeyShapes } from "../harness/plugs/keyshapes.ts";

export const RETRYABLE_STATUS: readonly number[] = [408, 429, 500, 502, 503, 504];
export const FATAL_STATUS: readonly number[] = [400, 401, 403, 404];
export const RETRY_DELAYS_MS: readonly number[] = [2000, 8000];
export const RETRY_AFTER_CAP_MS = 30000;
export const RETRY_MAX = RETRY_DELAYS_MS.length;

export type StatusClass = "retryable" | "fatal" | "unknown";

export function classifyStatus(status: number | undefined): StatusClass {
  if (status === undefined) return "unknown";
  if (RETRYABLE_STATUS.includes(status)) return "retryable";
  if (FATAL_STATUS.includes(status)) return "fatal";
  return status >= 500 ? "retryable" : "fatal";
}

/** SDK errors carry `status` (openai, anthropic) and sometimes `headers`; connection/timeout errors carry no status. */
export interface SdkErrorLike {
  status?: number | undefined;
  name?: string;
  message?: string;
  headers?: Record<string, string> | { get?(name: string): string | null | undefined } | undefined;
  code?: string | undefined;
}

export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as SdkErrorLike).status;
  return typeof status === "number" ? status : undefined;
}

export function errorClassName(error: unknown): string {
  if (error instanceof Error && error.name && error.name !== "Error") return error.name;
  if (typeof error === "object" && error !== null && "constructor" in error) return (error as object).constructor.name;
  return "Error";
}

/** Retryable = transient transport or status failures; anything else fails immediately. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  const status = errorStatus(error);
  if (status !== undefined) return classifyStatus(status) === "retryable";
  const name = errorClassName(error);
  return name === "APIConnectionError" || name === "APIConnectionTimeoutError" || name === "APITimeoutError" || name === "ConnectionError" || name === "TimeoutError";
}

/** `Retry-After` in seconds or as an HTTP date; undefined when absent or unparsable. */
export function retryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const headers = (error as SdkErrorLike).headers;
  if (headers === undefined || headers === null) return undefined;
  let raw: string | null | undefined;
  if (typeof (headers as { get?: unknown }).get === "function") raw = (headers as { get(name: string): string | null | undefined }).get("retry-after");
  else raw = (headers as Record<string, string>)["retry-after"] ?? (headers as Record<string, string>)["Retry-After"];
  if (raw === undefined || raw === null || raw.trim().length === 0) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), RETRY_AFTER_CAP_MS);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - Date.now()), RETRY_AFTER_CAP_MS);
}

export interface RetryOptions {
  provider: ProviderId;
  model: string;
  onNotice(text: string): void;
  /** injected for tests (fake timers) */
  sleep?(ms: number): Promise<void>;
  isRetryable?(error: unknown): boolean;
  retryAfter?(error: unknown): number | undefined;
}

let defaultSleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms);

/** Test hook: replaces the delay implementation used when RetryOptions.sleep is not given. */
export function configureRetrySleep(fn: ((ms: number) => Promise<void>) | undefined): void {
  defaultSleep = fn ?? ((ms) => Bun.sleep(ms));
}

/**
 * Runs `start` (which opens the stream) with the FR-06 budget. Only the stream opening is retried: once a delta was
 * yielded the caller stops calling this helper, so a later failure ends the turn without a retry.
 */
export async function withRetries<T>(start: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const retryable = opts.isRetryable ?? isRetryableError;
  const retryAfter = opts.retryAfter ?? retryAfterMs;
  let attempt = 0;
  for (;;) {
    try {
      return await start();
    } catch (error) {
      if (attempt >= RETRY_MAX || !retryable(error)) throw toProviderError(error, opts.provider, opts.model);
      const delay = retryAfter(error) ?? RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0;
      attempt++;
      opts.onNotice(`${providerDisplayName(opts.provider)} ${errorClassName(error)} -> retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${RETRY_MAX})...`);
      await sleep(delay);
    }
  }
}

const KEY_VARS: Record<string, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", zai: "ZAI_API_KEY" };

/** Wraps any SDK error into a self-contained ProviderError naming provider, model, and the provider's message (never a key). */
export function toProviderError(error: unknown, provider: ProviderId, model: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const status = errorStatus(error);
  const display = providerDisplayName(provider);
  const providerMessage = redactKeyShapes(error instanceof Error ? error.message : String(error));
  const cls = errorClassName(error);
  if (status === 401 || status === 403) {
    const variable = KEY_VARS[provider] ?? "the provider key";
    return new ProviderError(`${display} rejected the API key for model '${model}' (HTTP ${status}).`, `Check ${variable} (environment or .api-keys.txt).`, { provider, model, status, retryable: false });
  }
  const retryable = isRetryableError(error);
  return new ProviderError(`${display} ${cls}${status !== undefined ? ` (HTTP ${status})` : ""} for model '${model}': ${providerMessage}`, retryable ? "The failure is transient; the turn was retried within the budget." : "Fix the request or the configuration; see the provider message.", { provider, model, status, retryable });
}

/** Removes anything that looks like a key from free text (IG: no key value in logs, events, or errors). */
export { redactKeyShapes } from "../harness/plugs/keyshapes.ts";

