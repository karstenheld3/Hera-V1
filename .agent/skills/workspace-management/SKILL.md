---
name: workspace-management
description: Manages multi-repo workspace setup, PromptSystem synchronization, and knowledge distribution. Use when configuring workspace constants, syncing between source and target repos, verifying workspace integrity, or committing across multiple repos.
compatibility: PowerShell 7+ for diff/sync scripts
---

# Workspace Management

Manages workspace setup, PromptSystem sync, and knowledge distribution across product/dev/company repo architectures.

References (loaded on demand):
- WORKSPACE-GUIDES.md - High-level guidance on workspace setup, product/dev separation, sync sources
- WORKSPACE-RULES.md - Verifiable rules for workspace integrity, required files and constants
- WORKSPACE_SETUP_QUESTIONNAIRE.md - Interactive questionnaire for creating new workspaces with defaults and schema section with 27 setup fields
- WORKSPACE_SETUP_REPORT_TEMPLATE.md - Report template for workspace setup analysis and comparison reports
- DEV_REPO_NOTES_TEMPLATE.md - Template for DevRepo NOTES.md with all workspace constants
- PRODUCT_REPO_README_TEMPLATE.md - Template for ProductRepo README.md
- COMPANY_REPO_NOTES_TEMPLATE.md - Template for CompanyRepo NOTES.md with sync policy tracking
- sync.ps1 - Generic sync script with -diff and -execute modes
- LOCAL_ENVIRONMENTS.md - Per-runtime setup instructions for local development environments
- compare-workspace-setup.md - Thin workflow dispatching to Procedure 7 for two-workspace comparison

## MUST-NOT-FORGET

1. All paths must come from workspace constants in DevRepo NOTES.md - never hardcode project-specific paths
2. Always run sync.ps1 -diff before -execute - review changes before applying
3. Check never_overwrite patterns - files matching never_overwrite are never overwritten or deleted during sync
4. Rollback on shared branches (main, master, remote-tracked) requires explicit confirmation - advise revert commit instead
5. Privacy gate - no real identifiers, project names, or paths in any skill file
6. Sync config is JSON-based: promptsystem-sync.json at target [WORKSPACE_FOLDER] root is single source of truth - no NOTES.md prose lookup
7. Document placement: specs/ for verifiable agent instructions (_SPEC_*, _IMPL_*, _TEST_*, rules files with IDs), docs/ for explanatory knowledge (_INFO_*, research articles). _TASKS_* stays in session folders. Folders are optional by default, enforced when workspace-management is active (WS-DP-06). See WORKSPACE-RULES.md WS-DP-01 through WS-DP-06.

## Intent Lookup

User wants to...
- Create a new workspace → WORKSPACE_SETUP_QUESTIONNAIRE.md questionnaire
- Compare workspace settings → Procedure 1, FR-15
- Update workspace from source → Procedure 2, FR-16
- Roll back workspace settings → Procedure 3, FR-17
- Check if repo is synced or self-contained → Procedure 4, FR-18
- Check workspace integrity → Procedure 4, FR-18
- Compare PromptSystem files → Procedure 1, FR-19
- Update PromptSystem from source → Procedure 2, FR-20
- Roll back PromptSystem → Procedure 3, FR-21
- Check PromptSystem integrity → Procedure 4, FR-22
- Compare knowledge bundles → Procedure 1, FR-23
- Update knowledge from source → Procedure 2, FR-24
- Roll back knowledge → Procedure 3, FR-25
- Check knowledge integrity → Procedure 4, FR-26
- Commit across multiple repos → Procedure 5, FR-30
- Analyze workspace setup and generate report → Procedure 6, FR-67
- Compare workspace setup between two workspaces → Procedure 7, FR-74
- Check document placement → Procedure 4 (Integrity), WS-DP rules

## Core Procedures

### 1. Compare

```
1. Read promptsystem-sync.json from target [WORKSPACE_FOLDER] root
2. Determine sync area (WORKSPACE, PROMPTSYSTEM, KNOWLEDGE)
3. Determine sync source and target from config source entries
4. Run sync.ps1 -diff -sources <source> -targets <target> -configs <config>
5. Review structured diff report: new files, modified files, deleted files, skipped files
6. Note excluded files (filtered by bundle include/exclude rules) with -verbose
```

Use before any sync operation to preview changes.

### 2. Update

```
1. Run Compare procedure first
2. Review diff preview - check for breaking changes, locally-modified files
3. Read all sync config from target's promptsystem-sync.json (bundles, filters, never_overwrite, deprecated)
4. Confirm sync: prompt user (yes/go/confirmed/execute/apply to proceed, no/cancel/abort/stop to abort)
5. Run sync.ps1 -execute -sources <source> -targets <target> -configs <config>
6. Verify last_sync timestamp updated in promptsystem-sync.json
7. Report results per file: added, modified, deleted, skipped
```

Use to sync PromptSystem from source, knowledge from Company, or specs from Company. Downstream = sync from source to all targets. Upstream = sync from here back to source.

Note: When called from /workspace-setup sync, scoped to setup files only (NOTES.md, promptsystem-sync.json, folder structure) — not PromptSystem content or knowledge bundles.

### 3. Rollback

```
1. Determine area to rollback (WORKSPACE, PROMPTSYSTEM, KNOWLEDGE)
2. Check current branch: if shared (main, master, remote-tracked), display warning
3. Advise manual revert commit for shared branches. Proceed only with explicit confirmation
4. For non-shared branches: use git history to identify previous version
5. Roll back using git checkout of previous committed version
6. Report what changed between current and rolled-back version
```

Use when sync introduced errors or unwanted changes. IG-07: rollback on shared branches is dangerous - always warn first.

### 4. Integrity Check

```
1. Determine area to check (WORKSPACE, PROMPTSYSTEM, KNOWLEDGE)
2. Detect workspace type (SOFTWARE-DEV or GENERAL) and mode (SINGLE-PROJECT, MONOREPO, WORKSPACE)
3. For WORKSPACE: verify required constants in DevRepo NOTES.md, required files exist, workspace structure matches declared mode
4. For PROMPTSYSTEM: verify agent folder has rules/, workflows/, skills/ subfolders, no deprecated files
5. For KNOWLEDGE: verify knowledge folder exists if [DEV_KNOWLEDGE_FOLDER] set, all bundles in promptsystem-sync.json exist, no empty bundles
6. If GENERAL: verify dev-only constants and sections are absent (WS-CT-09). Do not report missing product repo, Build/Test, Runtime, or Release Configuration as gaps. Dimension 1 = N/A.
7. Report sync relationship state (SYNCED or SELF-CONTAINED)
8. Report gaps and incompatibilities
9. Fix actions: missing constant -> add with template default. Missing file -> create from template. Broken reference -> report only. Structural violation -> report only
```

Use via /verify workspace context. Downstream customizations are allowed and do not fail verification. GENERAL workspaces pass with simplified constants (no product repo, no build infrastructure, no Release Configuration).

Note: When called from /workspace-setup verify, also reads schema fields from WORKSPACE_SETUP_QUESTIONNAIRE.md in addition to WORKSPACE-RULES.md. Schema-aware mode evaluates each schema field for status (OK/GAP/STALE/DEVIATION/N/A) and proposes fixes.

### 5. Multi-Repo Commit

```
1. Detect WORKSPACE mode (*.code-workspace file exists)
2. Detect changes across all git repos in workspace
3. Commit order: 1) product repo, 2) dev repo, 3) all other workspace repos
4. For each repo with changes:
   a. Detect uncommitted changes
   b. Analyze by type (feat, fix, docs, test, chore)
   c. Use git -C [repo_path] for all git operations
   d. Detect and use per-repo git config (user.name, user.email)
   e. Create conventional commits
5. If a repo commit fails: report error, continue with remaining repos, summarize partial success
6. Skip repos with no changes silently
7. Report committed changes per repo at end
```

Use via /commit in WORKSPACE mode. SINGLE-PROJECT and MONOREPO modes use existing single-repo commit behavior.

### 6. Setup Analysis

```
1. Load WORKSPACE_SETUP_QUESTIONNAIRE.md schema section
2. Detect current workspace type and mode (reuse detection from Procedure 4)
3. For each field in schema (top-to-bottom): evaluate condition, read current value, compare against default, assign status (OK/GAP/STALE/DEVIATION/N/A)
4. Generate report following WORKSPACE_SETUP_REPORT_TEMPLATE.md structure
5. Output report to chat
6. Does not execute changes — analysis only
```

Use via /workspace-setup with no args. Analysis-only — does not modify workspace.

### 7. Compare Workspace Setup

```
1. Load schema from WORKSPACE_SETUP_QUESTIONNAIRE.md
2. Read workspace A (current): NOTES.md, promptsystem-sync.json, folder structure
3. Read workspace B (target from provided path): NOTES.md, promptsystem-sync.json, folder structure
4. For each schema field (top-to-bottom): evaluate condition for both workspaces, extract A value, extract B value, compare
5. Assign diff status: MATCH (identical), DIFF (both have value, different), ONLY_A (only in A), ONLY_B (only in B), N/A (condition not met)
6. For list fields: compare as sets (common, only-A, only-B)
7. Generate diff report following WORKSPACE_SETUP_REPORT_TEMPLATE.md adapted for two-workspace comparison
8. Output report to chat
9. Does not modify either workspace — analysis only
10. If user requests applying differences: dispatch to Procedure 2 with appropriate direction
```

Use via /workspace-setup compare or /compare-workspace-setup. Comparison-only — does not modify either workspace without confirmation.

## Gotchas

- Sync config is JSON-based - All sync configuration lives in promptsystem-sync.json at target [WORKSPACE_FOLDER] root. No NOTES.md prose lookup or hardcoded arrays
- never_overwrite overrides deprecated - Files matching never_overwrite patterns are protected from both overwrite and deletion, even if also matching deprecated patterns
- Rollback on shared branches - Using git checkout on shared branches (main, master) can cause issues for other contributors. Always use revert commit instead. IG-07 requires explicit confirmation

## Quick Config

Always required workspace constants in DevRepo NOTES.md:

```
## Workspace Constants
- [WORKSPACE_FOLDER]: [current workspace root path]
- [PRODUCT_REPO_FOLDER]: [WORKSPACE_FOLDER]\..\[product-repo-name]
- [DEV_KNOWLEDGE_FOLDER]: [WORKSPACE_FOLDER]\knowledge
- [DEV_SPECS_FOLDER]: [WORKSPACE_FOLDER]\specs
- [PRODUCT_DOCS_FOLDER]: [PRODUCT_REPO_FOLDER]\docs
- [AGENT_FOLDER]: [WORKSPACE_FOLDER]\[AGENT_FOLDER_NAME] (e.g., .devin, .claude)
- [SESSIONS_FOLDER]: [WORKSPACE_FOLDER]\_sessions
```

Required for SYNCED only (remove if SELF-CONTAINED):

```
- [COMPANY_REPO_FOLDER]: [WORKSPACE_FOLDER]\..\Company
- [KNOWLEDGE_SOURCE_FOLDER]: [COMPANY_REPO_FOLDER]\knowledge
- [SPECS_SOURCE_FOLDER]: [COMPANY_REPO_FOLDER]\specs
```

See DEV_REPO_NOTES_TEMPLATE.md for full template with defaults and instructions.
