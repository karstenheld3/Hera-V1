---
description: Create conventional commits
auto_execution_mode: 3
---

# Commit Workflow

Create conventional commits for staged changes.

## Required Skills

- @skills:git-conventions for commit message format

## MUST-NOT-FORGET

- **Suppress git noise**: Use `2>$null` on `git add` (CRLF warnings go to stderr) and `-q` on `git commit` (suppresses rename/summary output). Without this, large repos produce hundreds of lines that cause agent blocking commands to hang or time out.
- **Use non-blocking execution** (`Blocking: false`, `WaitMsBeforeAsync: 5000`) for `git add -A` when many files are affected (e.g., version bumps, bulk renames). Check completion with `command_status`.
- **Workspace-only scope**: Only commit and push the workspace repo(s). In WORKSPACE mode (*.code-workspace file exists), commit repos referenced in the workspace file - these may be physically outside `[WORKSPACE_FOLDER]` (e.g., ProductRepo at `[WORKSPACE_FOLDER]\..`). In SINGLE-PROJECT and MONOREPO modes, commit only the workspace repo itself. Never commit or push sync targets (repos in promptsystem-sync.json), or any repo not part of the workspace unless [ACTOR] explicitly requests it. "all push" means "push all changes in the workspace repo(s)", not "push all repos that received files".

## Steps

1. Analyze what was done since last commit
2. If multiple activities with different files, plan multiple commits
3. Identify chronological order by file modification times
4. Separate into commits by type:
   - Research, specifications, plans (docs)
   - Implementation (feat/fix)
   - Tests (test)
   - Documentation (docs)
5. Follow @skills:git-conventions for message format
6. Execute commits until all changes committed

## Execution Rules

**Stage files**:
```powershell
git add -A 2>$null
# Or for specific files:
git add <files> 2>$null
```

**Commit**:
```powershell
git commit -q -m "<type>(<scope>): <description>"
```

**For bulk operations** (version bumps, large renames with 50+ files):
- Run `git add -A 2>$null` as non-blocking with `WaitMsBeforeAsync: 5000`
- Poll with `command_status` if not done within wait period
- Then run `git commit -q -m "..."` as blocking (commit itself is fast after staging)

## Commit Message Format

`<type>(<scope>): <description>`

Types: feat, fix, docs, refactor, test, chore, style, perf

## Multi-Repo Commit (WORKSPACE Mode)

Detect by: WORKSPACE mode (*.code-workspace file exists in workspace root).

When WORKSPACE mode is detected, commit changes across multiple git repos referenced in the `.code-workspace` file:

1. Read the `.code-workspace` file to identify all repos in the workspace (ProductRepo, DevRepo, CompanyRepo, others)
2. **Exclude repos not in the workspace file**: Linked repos, sync targets from promptsystem-sync.json, and any repo not referenced in the `.code-workspace` file are excluded. These repos are only committed when [ACTOR] explicitly requests it (e.g., "commit all synced repos too")
3. Commit order (product-first):
   1. Product repo first (primary deliverable)
   2. Dev repo second (documentation of product changes)
   3. All other workspace repos
4. For each repo with changes:
   - Detect uncommitted changes
   - Analyze by type (feat, fix, docs, test, chore)
   - Use `git -C [repo_path]` for all git operations (explicit scoping)
   - Detect and use per-repo git config (user.name, user.email) - do not assume workspace-wide git identity
   - Create conventional commits per type
5. If a repo commit fails:
   - Report failure with error message
   - Continue with remaining repos
   - Summarize partial success at end
   - Do not roll back already-committed repos
6. Skip repos with no changes silently
7. Report committed changes per repo at end

Rationale: Product repo changes are the primary deliverable. Dev repo changes are secondary. Temporary inconsistency (product committed, dev not) is acceptable because dev repo content is not a runtime dependency. Repos outside the workspace have their own git lifecycle managed by their owners.

In SINGLE-PROJECT and MONOREPO modes: commit and push only the workspace repo. Never commit or push linked repos or deploy targets without explicit [ACTOR] request.
