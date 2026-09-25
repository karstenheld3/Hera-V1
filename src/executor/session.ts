// Executor session events: session_started production and resume checks (HERAV1EXEC-SP01 FR-05; HERAV1EXEC-IP01 IS-02).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedConfig } from "../config/load.ts";
import { nowTs, type AgentEvent } from "../events.ts";
import { ROLE_NAMES, type ToolDefinition } from "../models.ts";
import type { Projection } from "../session/projection.ts";

/** Role → model/effort/provider for all five roles plus the limits the spec names (FR-05 item 3). */
export function configSnapshot(cfg: ResolvedConfig): Record<string, unknown> {
  const roles: Record<string, unknown> = {};
  for (const r of ROLE_NAMES) roles[r] = { model_id: cfg.roles[r].modelId, effort: cfg.roles[r].effort, provider: cfg.roles[r].provider };
  roles["websearch"] = { model_id: cfg.roles.websearch.modelId, effort: cfg.roles.websearch.effort, provider: cfg.roles.websearch.provider, alias_of: cfg.roles.websearch.aliasOf ?? null };
  const c = cfg.config;
  return {
    roles,
    compaction_threshold_fraction: c.compaction_threshold_fraction,
    compaction_threshold_max_tokens: c.compaction_threshold_max_tokens,
    max_tool_calls_per_prompt: c.max_tool_calls_per_prompt,
    auto_continue: c.auto_continue,
    tool_result_max_chars: c.tool_result_max_chars,
    rule_block_max_chars: c.rule_block_max_chars,
    supervisor: { ...c.supervisor },
    ipc: { ...c.ipc },
    harness: { ...c.harness },
    agent_folder: cfg.agentFolder,
    data_dir: cfg.dataDir,
    scripted: cfg.roles.generating.provider === "scripted",
  };
}

export function buildSessionStarted(systemPrompt: string, tools: readonly ToolDefinition[], snapshot: Record<string, unknown>, definition_hash: string, profile: string): AgentEvent {
  return {
    ts: nowTs(),
    proc: "exec",
    type: "session_started",
    system_prompt: systemPrompt,
    tool_definitions: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    config_snapshot: snapshot,
    definition_hash,
    profile,
  };
}

/** FR-05 resume check: definition_hash difference → WARNING (legacy prompt hash and model-change folded into one value). */
export function resumeWarnings(projection: Projection, current: { definition_hash: string }): string[] {
  const out: string[] = [...projection.warnings];
  const header = projection.header;
  if (header === undefined) return out;
  if (header.definition_hash !== "" && header.definition_hash !== current.definition_hash) {
    out.push(`WARNING: definition hash changed since this session was recorded (recorded ${header.definition_hash}; current ${current.definition_hash}) - the recorded system prompt is used.`);
  }
  if (projection.incompleteTurn !== undefined) out.push(`NOTICE: the last turn of the session did not finish (${projection.incompleteTurn.messagesDropped} in-flight message${projection.incompleteTurn.messagesDropped === 1 ? "" : "s"} dropped).`);
  return out;
}

/** Nearest ancestor (including `start`) that contains a .git entry. */
export function findGitRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
