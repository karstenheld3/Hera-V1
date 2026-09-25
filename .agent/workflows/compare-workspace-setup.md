---
description: Compare workspace setup between two workspaces using schema
auto_execution_mode: 1
---

# Compare Workspace Setup Workflow

Compare workspace settings between current and target workspace using the schema in WORKSPACE_SETUP_QUESTIONNAIRE.md. Generates a diff report with per-field status.

**Goal**: Diff report showing field-by-field comparison between two workspaces

**Why**: Identifies setup divergence between workspaces before syncing or merging configurations

## Required Skills

- @skills:workspace-management for WORKSPACE_SETUP_QUESTIONNAIRE.md schema, Procedure 7, Procedure 2

## MUST-NOT-FORGET

- Load schema from WORKSPACE_SETUP_QUESTIONNAIRE.md before comparison
- Read prose NOTES.md files (not scripts or generated files) for workspace settings
- Thin workflow — all comparison logic dispatched to Procedure 7, no embedded logic
- @rules:core-conventions.md [CONFIRMATION_KEYWORDS] required for optional apply step
- Do not duplicate schema field definitions — reference WORKSPACE_SETUP_QUESTIONNAIRE.md

## Prerequisites

- Target workspace path provided in [instructions]
- If target workspace missing NOTES.md or promptsystem-sync.json: report ONLY_A status for affected fields, continue comparison

## No Context Match

If no target path provided in [instructions], ask user for target workspace path. Do not proceed without a valid path.

## Steps

1. Load schema from WORKSPACE_SETUP_QUESTIONNAIRE.md in `[AGENT_FOLDER]/skills/workspace-management/`
2. Read workspace A (current): NOTES.md, promptsystem-sync.json, folder structure
3. Read workspace B (target from [instructions] path): NOTES.md, promptsystem-sync.json, folder structure
4. Dispatch to Procedure 7 in @skills:workspace-management for field-by-field comparison
5. Procedure 7 generates diff report in chat following WORKSPACE_SETUP_REPORT_TEMPLATE.md adapted for two-workspace comparison
6. If user requests applying differences: dispatch to Procedure 2 with appropriate direction, confirm with @rules:core-conventions.md [CONFIRMATION_KEYWORDS]

## Diff Status Values

- MATCH — identical values in both workspaces
- DIFF — both have value, values differ
- ONLY_A — value exists only in workspace A
- ONLY_B — value exists only in workspace B
- N/A — condition not met for this field in one or both workspaces

## Verification

- All applicable schema fields covered in the diff report
- Both workspaces read correctly (NOTES.md parsed, promptsystem-sync.json parsed, folder structure detected)
- Diff status assigned per field using the 5 status values
- Report follows WORKSPACE_SETUP_REPORT_TEMPLATE.md structure adapted for two-workspace comparison

## Output

Diff report with per-field comparison and summary counts:
`Compared: [N] fields | MATCH: [N] | DIFF: [N] | ONLY_A: [N] | ONLY_B: [N] | N/A: [N]`

## Quality Gate

- [ ] Schema loaded from WORKSPACE_SETUP_QUESTIONNAIRE.md
- [ ] Both workspaces read (NOTES.md, promptsystem-sync.json, folder structure)
- [ ] All applicable schema fields covered in diff report
- [ ] Diff status values correct (MATCH, DIFF, ONLY_A, ONLY_B, N/A)
- [ ] Report follows WORKSPACE_SETUP_REPORT_TEMPLATE.md structure
- [ ] No embedded comparison logic — all logic dispatched to Procedure 7
- [ ] Apply step requires @rules:core-conventions.md [CONFIRMATION_KEYWORDS]
