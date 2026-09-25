// ContinueBroker, PermissionBroker, and ElicitationBroker (HERAV1ACP-SP01 FR-08, FR-09; HERAV1ACP-IP01 IS-05). Port of V1 bridge.py.
// All three answer the Executor's `ask_user` through the Communicator without awaiting IPC; a `session/cancel` resolves
// their pending client requests as cancelled.

import type { Communicator } from "../communicator/core.ts";
import type { PayloadOf } from "../process/envelope.ts";
import { AcpConnection, ClientErrorResponse, RoundTripCancelled } from "./connection.ts";

export const CONTINUE_OPTIONS = [
  { optionId: "allow-once", name: "Continue", kind: "allow_once" },
  { optionId: "reject-once", name: "Stop", kind: "reject_once" },
] as const;

export const NO_ELICITATION_FALLBACK = "Client does not support structured questions - ask in plain text";

export interface BrokerDeps {
  connection: AcpConnection;
  comm: Communicator;
  sessionId: () => string;
  stderr: (line: string) => void;
  warn?: (text: string) => void;
}

/** Tool-call-limit continue → `session/request_permission` on a synthetic toolCallId (the only permission request). */
export class ContinueBroker {
  private counter = 0;
  constructor(private readonly deps: BrokerDeps) {}

  /** Builds the request params (pure, for shape tests). */
  static params(sessionId: string, turn: number): Record<string, unknown> {
    return { sessionId, toolCall: { toolCallId: `continue_${turn}` }, options: CONTINUE_OPTIONS.map((o) => ({ ...o })) };
  }

  /** Never awaited by the caller: the client's answer completes the round trip later. */
  handle(req: PayloadOf<"ask_user">): Promise<void> {
    this.counter++;
    return this.deps.connection
      .request("session/request_permission", ContinueBroker.params(this.deps.sessionId(), this.counter))
      .then((result) => {
        const outcome = (result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
        const proceed = outcome?.outcome === "selected" && outcome.optionId === "allow-once";
        this.deps.stderr(`  continue prompt (${req.detail ?? "tool-call limit"}) -> ${proceed ? "continue" : "stop"}.`);
        this.deps.comm.continueDecision(proceed);
      })
      .catch((error: unknown) => {
        if (error instanceof ClientErrorResponse) this.deps.stderr(`  WARNING: client answered request_permission with an error -> treated as stop: ${error.message}`);
        else if (!(error instanceof RoundTripCancelled)) this.deps.stderr(`  WARNING: request_permission failed -> treated as stop -> ${error instanceof Error ? error.message : String(error)}`);
        this.deps.comm.continueDecision(false);
      });
  }
}

export const PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
] as const;

/** Gate `pending` → `session/request_permission` on the pending tool call's `toolCallId` (U09, FR-08). */
export class PermissionBroker {
  constructor(private readonly deps: BrokerDeps) {}

  /** Builds the request params (pure, for shape tests). */
  static params(sessionId: string, toolCallId: string, summary: string): Record<string, unknown> {
    return { sessionId, toolCall: { toolCallId, title: summary }, options: PERMISSION_OPTIONS.map((o) => ({ ...o })) };
  }

  /** Never awaited by the caller: the client's answer completes the round trip later. */
  handle(req: PayloadOf<"ask_user">, toolCallId: string): Promise<void> {
    const effectId = req.effect_id ?? "";
    const summary = req.summary ?? req.tool ?? "";
    return this.deps.connection
      .request("session/request_permission", PermissionBroker.params(this.deps.sessionId(), toolCallId, summary))
      .then((result) => {
        const outcome = (result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
        const allow = outcome?.outcome === "selected" && outcome.optionId === "allow-once";
        this.deps.stderr(`  permission prompt (${summary}) -> ${allow ? "allow" : "deny"}.`);
        this.deps.comm.resolvePending(effectId, allow ? "allow" : "deny");
      })
      .catch((error: unknown) => {
        if (error instanceof ClientErrorResponse) this.deps.stderr(`  WARNING: client answered request_permission with an error -> treated as deny: ${error.message}`);
        else if (!(error instanceof RoundTripCancelled)) this.deps.stderr(`  WARNING: request_permission failed -> treated as deny -> ${error instanceof Error ? error.message : String(error)}`);
        else this.deps.stderr(`  WARNING: request_permission cancelled -> treated as deny.`);
        this.deps.comm.resolvePending(effectId, "deny");
        if (!(error instanceof RoundTripCancelled)) this.deps.warn?.(`WARNING: permission request failed - effect denied`);
      });
  }
}

/** ask_user_question → `elicitation/create` form mode when the client advertised `elicitation.form` (present AND non-null). */
export class ElicitationBroker {
  formSupported = false;
  constructor(private readonly deps: BrokerDeps) {}

  /** Client capability rule (HERAACPB-IN01 2.6): `elicitation.form` present and non-null; `{}` does not imply support. */
  static formSupportedFrom(clientCapabilities: unknown): boolean {
    if (typeof clientCapabilities !== "object" || clientCapabilities === null) return false;
    const elicitation = (clientCapabilities as { elicitation?: unknown }).elicitation;
    if (typeof elicitation !== "object" || elicitation === null) return false;
    const form = (elicitation as { form?: unknown }).form;
    return form !== undefined && form !== null;
  }

  /** Builds the request params (pure, for shape tests). */
  static params(sessionId: string, req: PayloadOf<"ask_user">): Record<string, unknown> {
    const labels = (req.options ?? []).map((o) => o.label).filter((l) => l.length > 0);
    const descriptions = (req.options ?? []).map((o) => `${o.label}${o.description !== undefined && o.description.length > 0 ? ` - ${o.description}` : ""}`);
    const answer: Record<string, unknown> =
      req.allow_multiple === true
        ? labels.length > 0
          ? { type: "array", items: { type: "string", enum: labels }, title: "Answer", description: descriptions.join("; ") }
          : { type: "array", items: { type: "string" }, title: "Answer" }
        : labels.length > 0
          ? { type: "string", enum: labels, title: "Answer", description: descriptions.join("; ") }
          : { type: "string", title: "Answer" };
    return { sessionId, mode: "form", message: req.question ?? "", requestedSchema: { type: "object", properties: { answer }, required: ["answer"] } };
  }

  handle(req: PayloadOf<"ask_user">): Promise<void> {
    if (!this.formSupported) {
      this.deps.comm.answer({ request_id: req.request_id, text: NO_ELICITATION_FALLBACK });
      return Promise.resolve();
    }
    return this.deps.connection
      .request("elicitation/create", ElicitationBroker.params(this.deps.sessionId(), req))
      .then((result) => {
        const r = (result ?? {}) as { action?: string; content?: Record<string, unknown> };
        if (r.action !== "accept") {
          this.deps.comm.answer({ request_id: req.request_id, text: "no answer (user declined)" });
          return;
        }
        const value = r.content?.["answer"];
        if (Array.isArray(value)) this.deps.comm.answer({ request_id: req.request_id, selected: value.map((v) => String(v)) });
        else if (typeof value === "string" && (req.options ?? []).some((o) => o.label === value)) this.deps.comm.answer({ request_id: req.request_id, selected: [value] });
        else if (value !== undefined && value !== null) this.deps.comm.answer({ request_id: req.request_id, text: String(value) });
        else this.deps.comm.answer({ request_id: req.request_id, text: "no answer (empty response)" });
      })
      .catch((error: unknown) => {
        if (error instanceof RoundTripCancelled) this.deps.comm.answer({ request_id: req.request_id, text: "no answer (cancelled)" });
        else {
          this.deps.stderr(`  WARNING: client answered elicitation/create with an error -> ${error instanceof Error ? error.message : String(error)}`);
          this.deps.comm.answer({ request_id: req.request_id, text: "no answer (client error)" });
        }
      });
  }
}
