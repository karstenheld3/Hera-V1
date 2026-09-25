// Error hierarchy (HERAV1AGNT-IP01 IS-06). Every constructor requires the corrective action so that
// user-visible failures are self-contained (HERAV1AGNT-SP01 IG-01). `category` equals the
// `error` event category set, so an error becomes an event without translation.

import type { ProviderId } from "./models.ts";

export const ERROR_CATEGORIES = ["provider", "config", "process", "limit"] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export class HeraError extends Error {
  readonly exitCode: number;
  readonly category: ErrorCategory | undefined;
  readonly action: string;

  constructor(message: string, action: string, exitCode: number, category?: ErrorCategory) {
    super(action.length > 0 ? `${message} ${action}` : message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.category = category;
    this.action = action;
  }
}

export class ConfigError extends HeraError {
  constructor(message: string, action: string) {
    super(message, action, 2, "config");
  }
}

export interface ProviderErrorDetails {
  provider?: ProviderId;
  model?: string;
  retryable?: boolean;
  status?: number;
}

export class ProviderError extends HeraError {
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, action: string, details: ProviderErrorDetails = {}) {
    super(message, action, 3, "provider");
    this.provider = details.provider;
    this.model = details.model;
    this.retryable = details.retryable ?? false;
    this.status = details.status;
  }
}

export class IpcError extends HeraError {
  constructor(message: string, action: string) {
    super(message, action, 4, "process");
  }
}

export class ToolError extends HeraError {
  constructor(message: string, action: string) {
    super(message, action, 1);
  }
}

export class ProfileError extends HeraError {
  constructor(message: string, action: string) {
    super(message, action, 5, "config");
  }
}

export class EventParseError extends HeraError {
  readonly lineNo: number | undefined;

  constructor(message: string, lineNo?: number) {
    super(lineNo === undefined ? message : `${message} (line ${lineNo})`, "Repair or remove the line in the session file before resuming.", 4, "process");
    this.lineNo = lineNo;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
