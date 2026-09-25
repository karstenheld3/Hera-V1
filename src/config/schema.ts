// HeraConfig Zod schema with the section 4 defaults of HERAV1PRCF-SP01 (HERAV1PRCF-IP01 IS-01).
// The schema is strict: a leftover V1 key in a V2-shaped file surfaces as a named error (EC-02).

import { z } from "zod";
import { ConfigError } from "../errors.ts";
import type { RoleName } from "../models.ts";

export const RoleSpec = z.strictObject({ model_id: z.string().min(1), effort: z.string().min(1) });
export type RoleSpec = z.infer<typeof RoleSpec>;

export const DEFAULT_ROLES: Readonly<Record<RoleName, RoleSpec>> = Object.freeze({
  generating: { model_id: "glm-5.2", effort: "high" },
  compacting: { model_id: "gpt-4.1-mini", effort: "low" },
  supervisor: { model_id: "gpt-4.1-mini", effort: "low" },
  memory: { model_id: "gpt-4.1-mini", effort: "low" },
});

export const DEFAULT_DENYLIST: readonly string[] = Object.freeze(["rm", "del", "rmdir", "erase", "ri", "Remove-Item", "Move-Item", "format", "kill", "pkill", "Stop-Process", "shutdown", "git push --force"]);

export const DEFAULT_PROTECTED_PATHS: readonly string[] = Object.freeze([
  ".api-keys.txt",
  "agent-config.json",
  "memory.secret",
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.gnupg",
  "**/.env*",
  "**/*.pem",
  "**/id_rsa*",
]);

const RolesSchema = z.strictObject({
  generating: RoleSpec,
  compacting: RoleSpec.optional(),
  supervisor: RoleSpec.optional(),
  memory: RoleSpec.optional(),
  websearch: RoleSpec.optional(),
});

export const SupervisorSection = z
  .strictObject({
    denylist: z.array(z.string()).default([...DEFAULT_DENYLIST]),
    stall_timeout_s: z.number().int().positive().default(120),
    review_every_calls: z.number().int().positive().default(10),
    cost_alert_usd: z.number().nonnegative().default(1.0),
    memory_dir: z.string().min(1).default("memories"),
    memory_top_k: z.number().int().nonnegative().default(5),
    memory_retention_days: z.number().int().nonnegative().default(0),
  })
  .prefault({});

export const DEFAULT_NETWORK_COMMANDS: readonly string[] = Object.freeze([
  "curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "ftp", "telnet",
  "bitsadmin", "certutil", "Invoke-WebRequest", "iwr", "Invoke-RestMethod", "irm", "Start-BitsTransfer",
]);

export const HarnessLocalSection = z
  .strictObject({
    read_allowlist: z.array(z.string()).default([]),
    protected_paths: z.array(z.string()).default([...DEFAULT_PROTECTED_PATHS]),
    network_commands: z.array(z.string()).default([...DEFAULT_NETWORK_COMMANDS]),
    // "all" = every run_command waits for operator approval; "unsafe" = auto-allow only command lines whose
    // normalized first statement starts with an operator prefix and that touch no network command and stay
    // inside the workspace; "off" = no approval gate.
    auto_approve_prefixes: z.array(z.string()).default([]),
    approval: z.enum(["unsafe", "all", "off"]).default("all"),
  })
  .prefault({});

export const HarnessSection = z
  .strictObject({
    profile: z.enum(["local", "passthrough", "scripted", "governed"]).default("local"),
    fsync: z.boolean().default(true),
    local: HarnessLocalSection,
  })
  .prefault({});

export const IpcSection = z
  .strictObject({
    heartbeat_s: z.number().int().positive().default(5),
    ack_timeout_ms: z.number().int().positive().default(5000),
    hello_timeout_ms: z.number().int().positive().default(5000),
    shutdown_timeout_ms: z.number().int().positive().default(3000),
    restart_budget: z.number().int().min(0).default(1),
  })
  .prefault({});

export const KeysSection = z
  .strictObject({
    allow_file: z.boolean().default(true),
  })
  .prefault({});

export const HeraConfigSchema = z.strictObject({
  roles: RolesSchema,
  agent_folder: z.string().min(1).default(".agent"),
  data_dir: z.string().min(1).default(".agent-data"),
  keys: KeysSection,
  rule_block_max_chars: z.number().int().positive().default(6000),
  max_tool_calls_per_prompt: z.number().int().positive().default(40),
  auto_continue: z.boolean().default(false),
  tool_result_max_chars: z.number().int().positive().default(50000),
  compaction_threshold_fraction: z.number().gt(0).lte(1).default(0.6),
  compaction_threshold_max_tokens: z.number().int().positive().default(150000),
  workspace_tree_max_depth: z.number().int().positive().default(4),
  workspace_tree_max_lines: z.number().int().positive().default(200),
  supervisor: SupervisorSection,
  ipc: IpcSection,
  harness: HarnessSection,
});

type ParsedHeraConfig = z.infer<typeof HeraConfigSchema>;

/** The resolved configuration: every role present (defaults applied), `websearch` optional. */
export type HeraConfig = Omit<ParsedHeraConfig, "roles"> & { roles: Record<RoleName, RoleSpec> & { websearch?: RoleSpec } };

export const ROLE_DEFAULT_ORDER: readonly Exclude<RoleName, "generating">[] = ["compacting", "supervisor", "memory"];

/** Parses a raw (already migrated) object; zod issues become one self-contained ConfigError; defaulted roles produce NOTICE lines. */
export function parseHeraConfig(raw: unknown, fileLabel: string): { config: HeraConfig; notices: string[] } {
  const result = HeraConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.map(String).join(".") ?? "";
    if (issue?.code === "unrecognized_keys") {
      const keys = (issue as { keys?: string[] }).keys ?? [];
      throw new ConfigError(`${fileLabel}: unknown key${keys.length === 1 ? "" : "s"} ${keys.map((k) => `'${path ? `${path}.` : ""}${k}'`).join(", ")}.`, "Remove the key or check the spelling against the HeraConfig schema (spec 03 section 4).");
    }
    const message = issue?.message ?? "invalid configuration";
    const target = path.length > 0 ? path : "(root)";
    if (target === "roles" || target === "roles.generating") {
      throw new ConfigError(`${fileLabel}: 'roles.generating' is required (${message}).`, "Add roles.generating with model_id and effort.");
    }
    throw new ConfigError(`${fileLabel}: '${target}' ${message}.`, "Fix the value; see spec 03 section 4 for the allowed shape.");
  }
  const parsed = result.data;
  const notices: string[] = [];
  const roles = { ...parsed.roles } as Record<string, RoleSpec | undefined>;
  for (const role of ROLE_DEFAULT_ORDER) {
    if (roles[role] === undefined) {
      const d = DEFAULT_ROLES[role];
      roles[role] = { ...d };
      notices.push(`NOTICE: role '${role}' not configured -> using default ${d.model_id} (${d.effort}).`);
    }
  }
  return { config: { ...parsed, roles: roles as HeraConfig["roles"] }, notices };
}

export const DEFAULT_CONFIG: HeraConfig = parseHeraConfig({ roles: { generating: { ...DEFAULT_ROLES.generating } } }, "defaults").config;

/** Validates that compaction defaults leave enough room for output and one tool result (FR-04 derived bound). Returns a NOTICE string if violated, undefined otherwise. */
export function validateCompactionBound(threshold: number, maxOutput: number, toolResultMaxChars: number, maxInput: number): string | undefined {
  const toolResultTokens = Math.floor(toolResultMaxChars / 4);
  if (threshold + maxOutput + toolResultTokens > maxInput) {
    return `NOTICE: compaction threshold (${threshold}) + max_output (${maxOutput}) + one tool result (${toolResultTokens} tokens) exceeds the generating model's max_input (${maxInput}). Consider lowering compaction_threshold_max_tokens or compaction_threshold_fraction.`;
  }
  return undefined;
}

/** Text of the default config file written on first run (zero-setup, DD-05); every default spelled out. */
export function defaultConfigText(): string {
  const full = {
    roles: { ...DEFAULT_ROLES },
    agent_folder: DEFAULT_CONFIG.agent_folder,
    data_dir: DEFAULT_CONFIG.data_dir,
    keys: DEFAULT_CONFIG.keys,
    rule_block_max_chars: DEFAULT_CONFIG.rule_block_max_chars,
    max_tool_calls_per_prompt: DEFAULT_CONFIG.max_tool_calls_per_prompt,
    auto_continue: DEFAULT_CONFIG.auto_continue,
    tool_result_max_chars: DEFAULT_CONFIG.tool_result_max_chars,
    compaction_threshold_fraction: DEFAULT_CONFIG.compaction_threshold_fraction,
    compaction_threshold_max_tokens: DEFAULT_CONFIG.compaction_threshold_max_tokens,
    workspace_tree_max_depth: DEFAULT_CONFIG.workspace_tree_max_depth,
    workspace_tree_max_lines: DEFAULT_CONFIG.workspace_tree_max_lines,
    supervisor: DEFAULT_CONFIG.supervisor,
    ipc: DEFAULT_CONFIG.ipc,
    harness: DEFAULT_CONFIG.harness,
  };
  return `${JSON.stringify(full, null, 2)}\n`;
}
