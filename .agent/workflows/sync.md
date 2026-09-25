---
description: Document synchronization
auto_execution_mode: 3
---

# Sync Workflow

## Required Skills

Invoke based on context:
- @skills:write-documents for document formatting rules
- @skills:coding-conventions for code-related sync

## Workflow

1. **Determine scope** - If user specifies "sync A with B", sync ONLY between A and B. Do NOT cascade to other documents.
2. If no explicit targets given, detect sync context (Code→Docs, Session→Project, etc.) and use full context-specific section
3. Read GLOBAL-RULES
4. Read the relevant Context-Specific section
5. Create a sync task list (scoped to determined targets only)
6. Work through sync task list
7. Run Final Steps

## GLOBAL-RULES

Apply to ALL sync operations:

- Always read source document/code BEFORE updating dependent documents
- Preserve existing IDs (FR-XX, DD-XX, etc.) - never renumber
- Add new items at end of relevant section with next available number
- Mark synced items with timestamp in Document History
- Update verification labels when status changes:
  - Code implemented and tested → `[TESTED]` or `[PROVEN]`
  - Assumption validated → `[VERIFIED]`
- Keep formatting consistent with target document style
- Never delete content without explicit user confirmation

## Sync Direction Reference

```
Code Changes
├─> IMPL (update implementation details)
├─> SPEC (update if behavior changed)
└─> TEST (update expected results)

SPEC Changes
├─> IMPL (add/update implementation steps)
└─> TEST (add/update test cases)

IMPL Changes
├─> SPEC (update if implementation reveals spec gaps)
└─> TEST (update test cases for edge cases)

Topic Folder → Session
├─> Session PROGRESS.md (topic status summary)
├─> Session PROBLEMS.md (cross-cutting problems)
└─> Session NOTES.md (key findings)

Step Folder → Session
├─> Session PROGRESS.md (step completion)
└─> STEPLOG.md at session root (step summary)

Session → Project
├─> Project NOTES.md (reusable decisions, patterns)
├─> Project PROBLEMS.md (resolved issues with project impact)
└─> Project PROGRESS.md (completed milestones)

File → Dependent Files (upstream and downstream)
├─> IMPL (update implementation details from code)
├─> SPEC (update if behavior changed)
├─> TEST (update expected results)
└─> Downstream consumers (update references, imports)

Major Project Changes
├─> README.md (new features, changed structure, updated usage)
├─> NOTES.md (new conventions, topic registry updates)
└─> PROGRESS.md (milestone completions, version changes)
```

## Final Steps

1. Re-read all modified documents
2. [VERIFY] cross-references are valid (IDs exist in source)
3. Update Document History section in each modified file
4. Check for orphaned references (target deleted but reference remains)

# CONTEXT-SPECIFIC

## Code to Documents (Code→Docs)

When implementation differs from plan or spec:

**Detect changes:**
- Compare implemented behavior vs SPEC requirements
- Compare implementation approach vs IMPL plan
- Note any deviations, additions, or simplifications

**Sync to IMPL:**
- Update implementation steps that changed
- Add edge cases discovered during implementation (EC-XX)
- Mark completed steps in verification checklist

**Sync to SPEC:**
- Update FR-XX if requirement interpretation changed
- Add DD-XX for design decisions made during implementation
- Update IG-XX if guarantees changed
- Sync behavioral descriptions only. Never sync code snippets, line numbers, or function signatures into SPEC (SPEC-CT-02)

**Sync to TEST:**
- Update TC-XX expected results if behavior changed
- Add TC-XX for new edge cases

## Specification Updates (SPEC→Downstream)

When SPEC changes after initial creation:

**Sync to IMPL:**
- Add implementation steps for new FR-XX
- Update steps affected by changed FR-XX
- Add edge case handling for new requirements

**Sync to TEST:**
- Add TC-XX for each new FR-XX
- Update TC-XX for changed requirements
- Remove or mark obsolete TC-XX for removed requirements

## Implementation Plan Updates (IMPL→TEST)

When IMPL plan changes:

**Sync to TEST:**
- Add TC-XX for new EC-XX edge cases
- Update test phases if implementation order changed
- Add setup/teardown for new dependencies

## Topic Folder to Session (Topic→Session)

When syncing topic folder findings to parent session:

**Sync PROGRESS.md:**
- Topic completion status → Parent PROGRESS.md `## Topic Folders` section
- Format: `- [ ] T##_Description: [one-line status summary]`

**Sync PROBLEMS.md:**
- Cross-cutting problems (affect other topics or session scope) → Parent PROBLEMS.md
- Topic-local problems stay in topic folder

**Sync NOTES.md:**
- Key findings relevant to overall session → Parent NOTES.md

**Sync FAILS.md and LEARNINGS.md:**
- On topic finalize: sync to parent if present

## Step Folder to Session (Step→Session)

When syncing step folder output to session root:

**Sync PROGRESS.md:**
- Step completion → Session PROGRESS.md

**Create STEPLOG:**
- Summary document at session root: `S##_Description_STEPLOG.md`
- See @skills:session-management STEPLOG template

## Session to Project (Session→Project)

When closing a session or syncing findings:

**Sync NOTES.md findings:**
- Key Decisions → Project NOTES.md (if reusable beyond session)
- Agent Instructions → Project rules or NOTES.md
- Important Findings → Relevant SPEC or INFO documents

**Sync PROBLEMS.md:**
- Resolved problems with project impact → Project PROBLEMS.md
- Discovered bugs in unrelated code → Project PROBLEMS.md or GitHub issues
- Deferred items → Project PROBLEMS.md with priority

**Sync PROGRESS.md:**
- Completed milestones → Project PROGRESS.md
- Tried But Not Used → Project NOTES.md (prevent re-exploration)
- Test coverage changes → Relevant TEST documents

## Verification Label Updates

When status changes occur:

**Promote labels:**
- Finding re-read and confirmed → `[ASSUMED]` → `[VERIFIED]`
- POC or test script works → `[VERIFIED]` → `[TESTED]`
- Works in actual implementation → `[TESTED]` → `[PROVEN]`

**Where to update:**
- INFO: Source claims and findings
- SPEC: Design decisions and assumptions
- IMPL: Edge case handling choices
- TEST: Expected behaviors

## Cross-Document Reference Sync

When IDs change or documents restructure:

**Check references:**
- IMPL references to SPEC (FR-XX, DD-XX, IG-XX)
- TEST references to SPEC and IMPL (FR-XX, EC-XX)
- Document "Depends on" headers

**Fix broken references:**
- Update ID if item was renumbered
- Remove reference if item was deleted
- Add note if reference target moved to different document

## Workspace Sync

**MUST-NOT-FORGET**:
- Run `sync.ps1 -diff` for ALL targets before any `-execute`
- Use `-preview_file` to generate template-formatted preview, read it, present in chat
- Present diff summary in chat text (not buried in command output)
- `-execute` is the confirmation — never run it without a preceding `-diff` preview shown in chat
- One target's diff is NOT sufficient preview for other targets

Detect by: user runs `/sync workspace`, `/sync knowledge`, `/sync specs`, `/sync workspace settings`, or `/sync sync settings`.

Read @skills:workspace-management SKILL.md before syncing.

### Use Cases

**`/sync workspace settings from repo xyz`** — compares NOTES.md and promptsystem-sync.json from repo xyz, merges or replicates them into current repo. Merge strategy: target files win for fields that exist in both; source-only fields are added.

**`/sync workspace settings to repo xyz`** — compares NOTES.md and promptsystem-sync.json from current repo, merges or replicates them into target repo xyz.

**`/sync sync settings from repo xyz`** — compares and replicates ONLY promptsystem-sync.json (not NOTES.md) into current repo.

**`/sync sync settings to repo xyz`** — compares and replicates ONLY promptsystem-sync.json into target repo xyz.

**`/sync knowledge from source`** — reads knowledge source from promptsystem-sync.json, runs `sync.ps1 -diff`, previews. Auto-executes on @rules:core-conventions.md [CONFIRMATION_KEYWORDS].

**`/sync knowledge to targets`** — reads target repos from source NOTES.md synced repos list, runs `sync.ps1 -diff` for each target, previews. Auto-executes on @rules:core-conventions.md [CONFIRMATION_KEYWORDS].

**`/sync specs from source`** — reads specs source from promptsystem-sync.json, runs `sync.ps1 -diff`, previews. Auto-executes on @rules:core-conventions.md [CONFIRMATION_KEYWORDS].

**`/sync specs to targets`** — reads target repos from source NOTES.md synced repos list, runs `sync.ps1 -diff` for each target, previews. Auto-executes on @rules:core-conventions.md [CONFIRMATION_KEYWORDS].

### Sync Procedure

1. Read `promptsystem-sync.json` from target `[WORKSPACE_FOLDER]` root
2. For each target entry in config:
   - Read `path` (relative agent folder, e.g., `.devin`, `.claude`), `source` (relative path to source agent folder)
   - `include`/`exclude` patterns, `never_overwrite` patterns come from the target entry
   - Deprecated files come from top-level `deprecated` array in promptsystem-sync.json
   - Run `sync.ps1 -diff -config <path> -preview_file <path>` for preview
   - Review structured diff report (add/overwrite/delete/unchanged/excluded)
3. Read preview file (markdown formatted per `PROMPTSYSTEM_SYNC_PREVIEW_TEMPLATE.md` from @skills:workspace-management):
   - One section per target (never aggregate across targets)
   - Files to add, modify, delete, skip (with reason)
   - Excluded files (filtered by target include/exclude patterns)
   - Deprecated files marked for deletion
   - Locally modified files (target modified after last_sync)
   - Group file lists by top-level folder when 10+ files
4. Prompt user for confirmation:
   - Confirmation keywords: @rules:core-conventions.md [CONFIRMATION_KEYWORDS]
   - Non-confirmation keywords: no, cancel, abort, stop
5. If confirmed:
   - Run `sync.ps1 -execute -config <path>`
   - Verify `last_sync` timestamp updated in target config
   - Report results: X added, Y modified, Z deleted, W skipped
6. If not confirmed: abort, no changes made

Sync direction:
- Downstream = sync from source to all targets (distribute content to dependent repos)
- Upstream = sync from here back to source (push local changes back to origin)

Never overwrite: files matching `never_overwrite` glob patterns in promptsystem-sync.json are protected from overwrite and deletion.
