---
description: Create, modify, verify, sync, or compare workspace setup with 5 use cases
auto_execution_mode: 3
---

# Workspace Setup Workflow

Create, modify, verify, sync, or compare workspace setup using the schema in WORKSPACE_SETUP_QUESTIONNAIRE.md. Supports 5 use cases via command dispatch.

**Goal**: A fully initialized or analyzed workspace with all required files, constants, and folder structure

**Why**: Eliminates manual setup errors, ensures PromptSystem structure compliance, and provides setup analysis and comparison capabilities

## Required Skills

- @skills:workspace-management for WORKSPACE_SETUP_QUESTIONNAIRE.md schema, procedures, and templates

## MUST-NOT-FORGET

- Load WORKSPACE_SETUP_QUESTIONNAIRE.md schema section before any analysis or comparison
- This is a thin workflow — dispatches to @skills:workspace-management procedures, no embedded logic
- Confirmation keywords: @rules:core-conventions.md [CONFIRMATION_KEYWORDS]
- File generation steps must use _WORKSPACE_SETUP_QUESTIONNAIRE.md as the copy filename (not _WORKSPACE_CREATION_QUESTIONNAIRE.md)
- Do not replicate questionnaire content — reference WORKSPACE_SETUP_QUESTIONNAIRE.md

## Prerequisites

### Use cases 1-4 (verify, sync, compare)

- Target workspace exists and contains NOTES.md or !NOTES.md

### Use case 5 (default — creation or analysis)

- For creation: target folder exists or can be created
- For creation: target folder does not already contain NOTES.md or !NOTES.md (abort if initialized)
- For analysis: target workspace exists with NOTES.md or !NOTES.md

## Command Dispatch

Determine use case from command argument:

- `verify` → Use Case 1
- `sync from [source]` → Use Case 2
- `sync to [target]` → Use Case 3
- `compare [path]` → Use Case 4
- `[instructions]` or no args → Use Case 5

## GLOBAL-RULES

Apply before any context-specific steps:

1. Load WORKSPACE_SETUP_QUESTIONNAIRE.md from `[AGENT_FOLDER]/skills/workspace-management/`
2. Do not replicate questionnaire or schema content in this workflow — reference the file
3. Each question must show default value and impact description from the guide
4. Confirmation keywords: @rules:core-conventions.md [CONFIRMATION_KEYWORDS]
5. No confirmation gates for workspace creation — non-destructive per WF-EX-01

# CONTEXT-SPECIFIC

## Use Case 1: Verify

Dispatches to Procedure 4 (Integrity Check) with schema-aware mode in @skills:workspace-management.

1. Load schema from WORKSPACE_SETUP_QUESTIONNAIRE.md
2. Dispatch to Procedure 4 with schema-aware flag — reads schema fields in addition to WORKSPACE-RULES.md
3. Procedure 4 proposes fixes for gaps and stale items
4. Proposed changes do NOT execute by default
5. Execute on @rules:core-conventions.md [CONFIRMATION_KEYWORDS]

## Use Case 2: Sync From Source

Dispatches to Procedure 2 (Update) scoped to setup files in @skills:workspace-management.

1. Load schema from WORKSPACE_SETUP_QUESTIONNAIRE.md
2. Read source workspace: NOTES.md, promptsystem-sync.json, folder structure
3. Dispatch to Procedure 2 scoped to setup files (NOTES.md, promptsystem-sync.json, folder structure) — not PromptSystem content or knowledge bundles
4. Procedure 2 previews changes (fields to add/modify)
5. Execute on @rules:core-conventions.md [CONFIRMATION_KEYWORDS]

## Use Case 3: Sync To Target

Dispatches to Procedure 2 (Update) reversed in @skills:workspace-management.

1. Load schema from WORKSPACE_SETUP_QUESTIONNAIRE.md
2. Read current workspace: NOTES.md, promptsystem-sync.json, folder structure
3. Dispatch to Procedure 2 scoped to setup files, reversed direction (current → target)
4. Procedure 2 previews changes (fields to add/modify in target)
5. Execute on @rules:core-conventions.md [CONFIRMATION_KEYWORDS]

## Use Case 4: Compare

Dispatches to Procedure 7 (Compare Workspace Setup) in @skills:workspace-management. See also: `/compare-workspace-setup` workflow.

1. Load schema from WORKSPACE_SETUP_QUESTIONNAIRE.md
2. Dispatch to Procedure 7 with target workspace path from command argument
3. Procedure 7 generates diff report with per-field status (MATCH, DIFF, ONLY_A, ONLY_B, N/A)
4. Report follows WORKSPACE_SETUP_REPORT_TEMPLATE.md adapted for two-workspace comparison
5. Read-only by default — does not modify either workspace
6. If user requests applying differences: dispatch to Procedure 2 with appropriate direction, confirm with @rules:core-conventions.md [CONFIRMATION_KEYWORDS]

## Use Case 5: Default (Creation or Analysis)

Two sub-variants based on command arguments:

### 5a: [instructions] — Workspace Creation

Dispatches to existing creation flow. Preserves the original workspace creation logic from the prior version of this workflow.

1. Load WORKSPACE_SETUP_QUESTIONNAIRE.md from `[AGENT_FOLDER]/skills/workspace-management/`
2. Present Section 1a (Workspace Type) to user
3. Present remaining applicable sections based on workspace type (see Context Match below)
4. Generate workspace files from templates:
   - Read DEV_REPO_NOTES_TEMPLATE.md from `[AGENT_FOLDER]/skills/workspace-management/`
   - Substitute collected answers into template placeholders
   - Create NOTES.md (SINGLE-PROJECT, GENERAL) or !NOTES.md (WORKSPACE) at workspace root
   - Create PROBLEMS.md, PROGRESS.md, ID-REGISTRY.md, SOPS.md, FAILS.md
   - Copy WORKSPACE_SETUP_QUESTIONNAIRE.md from `[AGENT_FOLDER]/skills/workspace-management/` to workspace root as `_WORKSPACE_SETUP_QUESTIONNAIRE.md`
   - Create empty folders: [AGENT_FOLDER], _sessions, _sessions/_archive, docs/
   - Create IDE launcher scripts (Devin.bat, DevinNext.bat) using templates from WORKSPACE-GUIDES.md "IDE Launcher Scripts" section. Use single-repo variant for SINGLE-PROJECT/GENERAL, multi-repo variant for WORKSPACE
   - For WORKSPACE: also create [folder-name].code-workspace (named after workspace folder), product repo README.md, knowledge/, specs/
5. Sync PromptSystem files from source to [AGENT_FOLDER] using @skills:workspace-management Procedure 2
6. Run `/verify workspace` to confirm all required files and constants are present

### 5b: No args — Setup Analysis

Dispatches to Procedure 6 (Setup Analysis) in @skills:workspace-management.

1. Load schema from WORKSPACE_SETUP_QUESTIONNAIRE.md
2. Dispatch to Procedure 6 — generates full analysis report in chat
3. Report follows WORKSPACE_SETUP_REPORT_TEMPLATE.md structure
4. Report contains all 6 sections with field-level status (OK, GAP, STALE, DEVIATION, N/A)
5. No changes executed — analysis only

### Context Match for Creation (5a)

**GENERAL** — Sections: 1 (Workspace Type and Mode) only. Skip to file generation after Section 1a.

**SINGLE-PROJECT** — Sections: 1 (Workspace Type and Mode), 3 (Dev Repo), 4 (Version Strategy), 6 (Release Configuration). Present Section 1a then 1b, then remaining applicable sections.

**WORKSPACE** — Sections: 1 (Workspace Type and Mode), 2 (Product Repo), 3 (Dev Repo), 4 (Version Strategy), 5 (Sync Sources), 6 (Release Configuration). Present Section 1a then 1b, then remaining applicable sections.

**No Context Match** — If Section 1a answer is GENERAL: use GENERAL flow. If Section 1b answer is neither SINGLE-PROJECT nor WORKSPACE, ask user to choose between the two options.

## Output

Per use case:
- Use Case 1 (Verify): `Verified: [N] fields checked | OK: [N] | GAP: [N] | STALE: [N] | DEVIATION: [N] | N/A: [N]`
- Use Case 2 (Sync From): `Synced from [source]: [N] fields added | [N] modified | [N] skipped`
- Use Case 3 (Sync To): `Synced to [target]: [N] fields added | [N] modified | [N] skipped`
- Use Case 4 (Compare): `Compared: [N] fields | MATCH: [N] | DIFF: [N] | ONLY_A: [N] | ONLY_B: [N] | N/A: [N]`
- Use Case 5a (Creation): `Created: [file] | Mode: [GENERAL|SINGLE-PROJECT|WORKSPACE] | Files: [N] | Folders: [N]`
- Use Case 5b (Analysis): `Analyzed: [N] fields | OK: [N] | GAP: [N] | STALE: [N] | DEVIATION: [N] | N/A: [N]`

## Quality Gate

- [ ] WORKSPACE_SETUP_QUESTIONNAIRE.md loaded before any operation
- [ ] Correct use case dispatched based on command argument
- [ ] All use cases dispatch to named procedures — no embedded logic
- [ ] Confirm/execute flow defined with @rules:core-conventions.md [CONFIRMATION_KEYWORDS]
- [ ] Copy filename is _WORKSPACE_SETUP_QUESTIONNAIRE.md (not _WORKSPACE_CREATION_QUESTIONNAIRE.md)
- [ ] For creation: all applicable sections presented with defaults and impact descriptions
- [ ] For creation: files generated from templates (not hardcoded content)
- [ ] For creation: all required tracking files created (NOTES.md, PROBLEMS.md, PROGRESS.md, ID-REGISTRY.md, SOPS.md, FAILS.md)
- [ ] For creation: PromptSystem synced to [AGENT_FOLDER]
- [ ] For creation: `/verify workspace` passed
