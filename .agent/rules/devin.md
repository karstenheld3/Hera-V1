---
trigger: always_on
---

# Devin/Cascade-Specific Rules

Agent-specific rules for Windsurf/Devin (Cascade) environments. Excluded from sync to non-Devin agent repos.

## Tool Constraints

- NEVER ask questions. NEVER use the `ask_user_question` tool. Resolve ambiguity through prompt analysis, not clarification requests
- The `ask_user_question` tool is FORBIDDEN. This includes all interactive prompt mechanisms. The only exception: when two interpretations lead to destructive, irreversible, and materially different outcomes

## Terminal Limits

**Cascade terminal limit (2026-03-09):** Max 4 concurrent terminals. Additional terminals are queued/delayed.

Before processing multiple files:

1. Run `tool --help` or read source
2. Execute on single file first
3. Verify output location and format
4. Scale to full batch

During execution:

- Use absolute paths (PowerShell jobs lose relative context)
- Use `run_command` with `Blocking: false` for parallel tasks
- Never open external terminals unless explicitly requested
- After first job completes, verify output before assuming rest will succeed

## Agent Folder Mapping

**[AGENT_FOLDER]** location for Devin/Cascade:
- `.devin/`

## Workspace Definition

- **[WORKSPACE]**: The Windsurf/VSCode workspace root folder

## Cascade-Specific Workflows

- `/switch-model` - Switch Cascade AI model tier (HIGH, MID, LOW)

## Cascade-Specific Skills

- `@devin-auto-model-switcher` - Switch Cascade AI model tier programmatically
