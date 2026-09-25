<PromptSystem MarkdownTablesAllowed=true />
# Workspace Setup Report Template

Guide for generating workspace setup analysis and comparison reports. Agent generates report in chat following this structure — not a fill-in form. References field IDs from the Setup Schema section in WORKSPACE_SETUP_QUESTIONNAIRE.md.

## Table of Contents

- [Analysis Report (Procedure 6)](#analysis-report-procedure-6)
- [Comparison Report (Procedure 7)](#comparison-report-procedure-7)

## Analysis Report (Procedure 6)

Single-workspace analysis report. One row per applicable schema field.

### Summary

```
Workspace: [path]
Type: [SOFTWARE-DEV|GENERAL]
Mode: [SINGLE-PROJECT|WORKSPACE|N/A]
Sync Relationship: [SYNCED|SELF-CONTAINED|N/A]

Fields checked: [N]
OK: [N] | GAP: [N] | STALE: [N] | DEVIATION: [N] | N/A: [N]
```

### Section 1: Workspace Type and Mode

| Field ID | Current | Default | Status | Proposed Fix |
|----------|---------|---------|--------|--------------|
| workspace_type | [value] | SOFTWARE-DEV | [OK\|GAP\|STALE\|DEVIATION\|N/A] | [fix or none] |
| workspace_mode | [value] | SINGLE-PROJECT | [status] | [fix or none] |

### Section 2: Product Repo

| Field ID | Current | Default | Status | Proposed Fix |
|----------|---------|---------|--------|--------------|
| product_repo_folder | [value] | myapp | [status] | [fix or none] |
| product_repo_description | [value] | A CLI tool for ... | [status] | [fix or none] |
| binary_build | [value] | no | [status] | [fix or none] |
| binary_path_pattern | [value] | dist/[appname]-{version}-win-x64.exe | [status] | [fix or none] |

### Section 3: Dev Repo / Workspace Root

| Field ID | Current | Default | Status | Proposed Fix |
|----------|---------|---------|--------|--------------|
| project_name | [value] | myapp | [status] | [fix or none] |
| project_goal | [value] | Describe what this project does | [status] | [fix or none] |
| agent_folder_name | [value] | .devin / .claude | [status] | [fix or none] |
| sessions_folder_name | [value] | _sessions | [status] | [fix or none] |
| sops_file_name | [value] | SOPS.md | [status] | [fix or none] |

### Section 4: Version Strategy

| Field ID | Current | Default | Status | Proposed Fix |
|----------|---------|---------|--------|--------------|
| version_source | [value] | promptsystem_folder | [status] | [fix or none] |
| tag_format | [value] | date | [status] | [fix or none] |
| post_release_bump | [value] | promptsystem_rename | [status] | [fix or none] |

### Section 5: Sync Sources

| Field ID | Current | Default | Status | Proposed Fix |
|----------|---------|---------|--------|--------------|
| sync_relationship | [value] | SYNCED | [status] | [fix or none] |
| promptsystem_source_path | [value] | [default] | [status] | [fix or none] |
| company_folder_path | [value] | [default] | [status] | [fix or none] |
| knowledge_folder | [value] | [default] | [status] | [fix or none] |
| specs_folder | [value] | [default] | [status] | [fix or none] |
| knowledge_include_patterns | [value] | ["*"] | [status] | [fix or none] |
| specs_include_patterns | [value] | ["*"] | [status] | [fix or none] |
| never_overwrite | [value] | [default] | [status] | [fix or none] |

### Section 6: Release Configuration

| Field ID | Current | Default | Status | Proposed Fix |
|----------|---------|---------|--------|--------------|
| github_releases | [value] | yes | [status] | [fix or none] |
| release_notes_directory | [value] | [default] | [status] | [fix or none] |
| run_tests_before_release | [value] | yes | [status] | [fix or none] |
| test_command | [value] | [default] | [status] | [fix or none] |
| version_consistency_gate | [value] | no | [status] | [fix or none] |

### List Field Details

For list-type fields with GAP or STALE status, expand missing/extra items:

```
[field_id]:
  Missing (in default, not in current): [item1, item2, ...]
  Extra (in current, not in default): [item1, item2, ...]
```

### Status Definitions

- OK — current value matches default
- GAP — field is missing or empty but condition is met (should have a value)
- STALE — field has a value but it references a deprecated/renamed file or path
- DEVIATION — field has a non-default value (valid user choice, no action needed)
- N/A — condition not met for this workspace type (field does not apply)

## Comparison Report (Procedure 7)

Two-workspace comparison report. One row per applicable schema field.

### Summary

```
Workspace A: [path]
Workspace B: [path]

Fields compared: [N]
MATCH: [N] | DIFF: [N] | ONLY_A: [N] | ONLY_B: [N] | N/A: [N]
```

### Per-Field Comparison

| Field ID | Workspace A | Workspace B | Status |
|----------|-------------|-------------|--------|
| workspace_type | [value] | [value] | [MATCH\|DIFF\|ONLY_A\|ONLY_B\|N/A] |
| workspace_mode | [value] | [value] | [status] |
| ... | ... | ... | [status] |

### List Field Details

For list-type fields with DIFF status, expand set differences:

```
[field_id]:
  Common: [item1, item2, ...]
  Only A: [item1, item2, ...]
  Only B: [item1, item2, ...]
```

### Diff Status Definitions

- MATCH — identical values in both workspaces
- DIFF — both have a value, values differ
- ONLY_A — value exists only in workspace A
- ONLY_B — value exists only in workspace B
- N/A — condition not met for this field in one or both workspaces

### Missing File Handling

If target workspace is missing NOTES.md or promptsystem-sync.json:
- Report ONLY_A status for affected fields (value exists only in workspace A)
- Continue comparison for remaining fields
- Note missing file(s) in summary
