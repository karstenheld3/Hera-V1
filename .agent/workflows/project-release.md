---
description: Create a config-driven project release with release notes, tags, and GitHub releases. Supports single-repo and multi-repo workspaces.
auto_execution_mode: 3
---

# Project Release Workflow

Create a config-driven project release supporting single-repo and multi-repo workspaces. All release parameters are read from `[RELEASE_CONFIG]` in workspace NOTES.md. Zero hardcoded paths, repo names, or version formats.

**Spec**: `_SPEC_RELEASE_PROJECT_WORKFLOW.md [RLSPROJ-SP01]`

## MUST-NOT-FORGET

1. ONE workflow file serves ALL workspace types - no per-repo customization of the workflow itself
2. All release configuration lives in workspace NOTES.md under `[RELEASE_CONFIG]` section
3. Detect workspace context first (single-repo vs multi-repo), then branch correctly
4. Product repo is always released first, dev repo second (if configured)
5. Agent MUST NOT execute build tools (build.bat, build.ps1, cargo, etc.) - user builds, agent verifies
6. Post-release version bump is mandatory, automatic, and the LAST step - never ask for confirmation
7. Read SOPS file (name from config) for workspace-specific procedures and deviations
8. No git tag is created before release notes are committed to the product repo
9. No GitHub release is created without explicit user confirmation, unless `github_release_confirm: false` is set in `[RELEASE_CONFIG]` (confirmation then given once, by config)
10. All paths in config use workspace constants - no absolute paths

## Prerequisites

- `[RELEASE_CONFIG]` section exists in workspace NOTES.md (or `!NOTES.md`)
- All configured repos have clean git worktree (no uncommitted changes)
- GitHub CLI (`gh`) installed and authenticated (or provide manual release URL)

## Context Detection

Before any release steps, detect workspace context:

1. Detect workspace mode: `*.code-workspace` file exists in workspace root → WORKSPACE mode (multi-repo), else → SINGLE-PROJECT or MONOREPO
2. Read `[RELEASE_CONFIG]` from workspace NOTES.md (or `!NOTES.md`)
3. If no `[RELEASE_CONFIG]` section: error and halt. Guide user to add config using `DEV_REPO_NOTES_TEMPLATE.md` from `@skills:workspace-management`
4. Count `[RELEASE_REPO]` blocks: 1 → single-repo flow, 2+ → multi-repo flow
5. Validate config (see Config Validation below)
6. Verify all configured repos have clean worktree: `git -C [repo_path] status --porcelain` must return empty. If any repo is dirty: halt and report which files are uncommitted in which repo
7. Read SOPS file (name from config `sops_file` key) for workspace-specific procedures and deviations
8. Resolve all workspace constants in repo paths (e.g., `[WORKSPACE_FOLDER]`, `[PRODUCT_REPO_FOLDER]`, `[PROMPTSYSTEM_FOLDER]`)

## Config Validation

After parsing `[RELEASE_CONFIG]`, validate before proceeding:

- Required global keys MUST be present: `sops_file`, `sessions_folder`, `release_notes_dir`
- Optional global key `github_release_confirm` in [`true`, `false`], default `true`. `false` = create GitHub releases for every repo with `github_release: true` without asking
- Each `[RELEASE_REPO]` block MUST have all required keys: `path`, `role`, `tag_format`, `version_source`, `post_release_bump`
- Enum values MUST be valid:
  - `tag_format` in [`date`, `semver`]
  - `role` in [`product`, `dev`]
  - `version_source` in [`promptsystem_folder`, `pyproject_toml`, `package_json`, `none`]
  - `post_release_bump` in [`promptsystem_rename`, `patch_bump`, `minor_bump`, `none`]
- Conditional keys MUST be present when parent key requires:
  - `version_file` when `version_source` is `pyproject_toml` or `package_json`
  - `binary_path_pattern` when `binary_build` is `true`
- If validation fails: report specific missing or invalid key and halt

## Version Extraction

- `promptsystem_folder`: Parse `[PRODUCT_VERSION]: X.Y` from NOTES.md, extract `X.Y`
- `pyproject_toml`: Parse `version = "X.Y.Z"` from configured `version_file`
- `package_json`: Parse `"version": "X.Y.Z"` from configured `version_file`
- `none`: No version extraction; tag is the version identifier

## Tag Derivation

- `date` format: `YYYY-MM-DD` from current date (or user-specified date)
- `semver` format: `vX.Y.Z` from version source. Version source file must already contain the target release version (user bumps via SOPS procedure or manual edit before invoking workflow)

## Test Command Lookup

For each repo, `test_command` lookup order:
1. `[RELEASE_REPO]` config in `[RELEASE_CONFIG]`
2. `## Build/Test Rules` section in NOTES.md
3. Skip tests for that repo, log "no test command configured"

## Session Inventory

Find all session folders in configured `sessions_folder`:

1. List directories in `sessions_folder`, exclude any whose name contains `Archive`
2. For each session folder, collect:
   - Session name and date (from folder name or NOTES.md)
   - Goal (from session NOTES.md `## Session Info` section)
   - Status (from session PROGRESS.md - complete or in-progress)
   - Artifacts: `_INFO_*.md`, `_SPEC_*.md`, `_IMPL_*.md`, `__STRUT_*.md`, scripts
   - Key findings (from session NOTES.md `## Important Findings` section)
3. Session inventory runs against the repo containing the sessions folder (typically dev repo in multi-repo mode)

## Single-Repo Release Flow

```
User invokes /project-release
├─> Detect workspace context (see Context Detection above)
├─> Read SOPS file for workspace-specific procedures
├─> Run tests (if test_command configured)
│   └─> If tests fail: halt, report failures
├─> Determine release scope (commits since last tag)
├─> Inventory sessions from configured sessions_folder
├─> Generate release notes
│   └─> Write to product repo's release_notes_dir
├─> Commit release notes to product repo
│   └─> Commit message: `docs: add release notes for [TAG]`
├─> [If binary_build: true]
│   ├─> Ask user to build binary
│   └─> Verify binary exists at configured path
├─> [If version_gate: true]
│   └─> Run version consistency check
│       └─> If mismatch or binary not runnable: halt
├─> Check if tag already exists (locally and on remote)
│   └─> If exists at same commit: skip, log "tag already exists"
│   └─> If exists at different commit: halt, report conflict
├─> Create git tag in product repo
├─> Push tag and commits to remote
├─> Present summary to user
│   └─> Ask: "Create GitHub release? (y/n)" (skip question if github_release_confirm: false → treat as confirmed)
├─> [If confirmed]
│   ├─> Check if GitHub release already exists for tag
│   └─> Create GitHub release with notes and assets (or skip if exists)
├─> Execute post-release version bump without asking
│   └─> Commit and push bump
└─> Report results: release URLs, tag names, binary paths, session count
```

## Multi-Repo Release Flow

```
User invokes /project-release
├─> Detect workspace context (see Context Detection above)
├─> Read SOPS file for workspace-specific procedures
├─> Determine release scope for each repo
├─> Inventory sessions (from configured sessions_folder in dev repo)
│
├─> [PRODUCT REPO]
│   ├─> Run tests (if test_command configured)
│   │   └─> If tests fail: halt
│   ├─> Generate release notes
│   │   └─> Write to PRODUCT repo's release_notes_dir
│   ├─> Commit release notes to product repo
│   │   └─> Commit message: `docs: add release notes for [TAG]`
│   ├─> [If binary_build: true]
│   │   ├─> Ask user to build binary
│   │   └─> Verify binary exists
│   ├─> [If version_gate: true]
│   │   └─> Run version consistency check for product repo
│   │       └─> If mismatch or binary not runnable: halt
│   └─> (Tagging deferred to two-phase step below)
│
├─> [DEV REPO]
│   ├─> Run tests (if test_command configured)
│   │   └─> If tests fail: halt
│   ├─> Research last evaluation results (from session artifacts, llm-evaluation skill outputs)
│   ├─> Generate dev release notes referencing product release
│   ├─> Commit dev release notes
│   │   └─> Commit message: `docs: add release notes for [TAG]`
│   └─> (Tagging deferred to two-phase step below)
│
├─> [TWO-PHASE TAGGING]
│   ├─> Phase 1: Create all tags locally (product + dev)
│   │   └─> If any tag creation fails: delete all local tags, halt
│   ├─> Phase 2: Push all tags to remote (product first, then dev)
│   │   └─> Use git push --atomic for tag + commit per repo
│   └─> Present summary to user
│       └─> Ask: "Create GitHub releases? (y/n)" (skip question if github_release_confirm: false → treat as confirmed)
│
├─> [If confirmed]
│   ├─> Check for existing GitHub releases (skip if exists)
│   ├─> Create product GitHub release with notes and binary assets
│   └─> Create dev GitHub release (notes reference product release)
│
├─> Execute post-release version bump per repo without asking
│   ├─> Product repo bump (if configured)
│   └─> Dev repo bump (if configured)
│
└─> Report all results: all release URLs, tags, binary paths
```

## Release Notes Template

The workflow uses this standard template (defined by the workflow, not per-workspace):

```markdown
# Release Notes: [TAG]

## Summary

This release covers [N] sessions from [date range], focusing on [themes].

## Sessions Overview

### [N]. [Session_Name]

**Goal**: [from session NOTES.md]

**Outcome**: [summary of what was achieved]

**Artifacts:**
- `[filename]` - [description]

**Key Findings:** (if any)
- [finding 1]
- [finding 2]

---

[Repeat for each session]

## New Skills Deployed

[List any new skills added to agent folder]

## New Workflows

[List any new workflows added to agent folder]

## Workspace Files

[List changes to workspace-level files: FAILS.md, NOTES.md, etc.]

## Statistics

- **Total Sessions**: [N]
- **Total Documents Created**: [N]
- [Other relevant stats]
```

Default naming: `RELEASE_NOTES_v{VERSION}_{DATE}.md` (configurable via `release_notes_naming`)
Default tag annotation: `Release {TAG}: {SUMMARY}` (configurable via `tag_annotation_template`)

## Version Consistency Gate

When `version_gate` is `true` for a repo, verify version alignment before tagging:

1. Check version source file version matches planned tag version
2. Check binary filename version matches (when `binary_build` is true)
3. Check binary `--version` output matches (when `binary_build` is true)
4. Check planned git tag matches version source

If binary cannot execute (non-zero exit, file not found, permission denied): report as "binary not runnable" (distinct from version mismatch), halt, and instruct user to verify binary platform compatibility.

If version mismatch: halt and instruct user to rebuild.

## Post-Release Version Bump

After all tags pushed and GitHub releases created (or skipped), execute post-release bump automatically without asking for user confirmation. This is not a discretionary step.

Bump strategy per repo:

- `promptsystem_rename`: Read current version from NOTES.md, increment minor, rename `PromptSystemVX.Y` folder to `PromptSystemVX.Y+1`, update NOTES.md, sync to `[AGENT_FOLDER]/`, commit, push. Follow SOPS SOP 7 or equivalent procedure in workspace's SOPS file
- `patch_bump`: Read version from `version_file`, increment patch, write back, commit, push
- `minor_bump`: Read version from `version_file`, increment minor, reset patch to 0, write back, commit, push
- `none`: Skip

Bumped changes MUST be committed and pushed.

## Failure Recovery

### Principles

- Never delete remote tags. Tags on `origin` are immutable - treat as published
- Never force-push tags. A moved tag breaks downstream consumers
- When in doubt: halt and report. Agent MUST NOT attempt destructive recovery without user guidance

### Release notes commit failed
- Detection: `git commit` returns non-zero
- Recovery: Abort release. Release notes file may be staged but uncommitted. User fixes issue and re-invokes workflow. Re-run detects no tag exists, re-commits notes

### Tag creation failed (local)
- Detection: `git tag` returns non-zero
- Recovery (single-repo): Abort. No tag exists locally or remotely. User fixes issue and re-invokes
- Recovery (multi-repo): Delete all locally created tags from this run. Abort. User fixes issue and re-invokes

### Tag push failed
- Detection: `git push` returns non-zero
- Recovery: Local tag exists but remote does not. Check if remote tag exists at same commit. If yes: log "tag already on remote", continue. If no: retry push once. If retry fails: abort, report push error, leave local tag in place. User resolves remote issue and re-invokes

### GitHub release creation failed
- Detection: `gh release create` returns non-zero or `gh` not installed
- Recovery: Tags are already pushed (immutable). Report failure reason. If `gh` not installed: provide manual release URL (`https://github.com/[OWNER]/[REPO]/releases/new?tag=[TAG]`). User creates release manually. Post-release bump proceeds regardless - GitHub release is not a gate for version bump

### Post-release bump failed
- Detection: Version file write fails, folder rename fails, or commit/push fails
- Recovery: Tags and GitHub releases (if created) are immutable. Report failure. If folder rename partially completed: user manually finishes rename and updates NOTES.md. If version file write failed: no state changed, user fixes and re-invokes. If commit failed: user resolves and commits manually. Re-run detects existing tag, skips tagging, retries bump

## Idempotency

- Re-running workflow after partial failure MUST detect existing tags and skip re-tagging
- Re-running after GitHub release created MUST detect existing release and skip
- Before creating any tag: check if tag already exists locally and on remote. If tag exists at same commit: skip. If at different commit: halt and report conflict
- Before creating GitHub release: check if release already exists for tag. If exists: skip

## Logging

- Announce each phase before executing: context detection, tests, release notes, build, version gate, tagging, GitHub release, bump
- Report success or failure of each step with specific details (tag name, release URL, binary path)
- Error messages MUST state what failed, why, and recovery action
- Final report MUST be emitted in chat, not to a file
