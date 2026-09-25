# Prompts Example 02: Robustness Card

Demonstrates a complete `__CARD_01-Robustness.md` with project-specific banned commands, time caps, and always rules for hang prevention.

## Context

This example shows a robustness card loaded by every implementation prompt in a sequence. The card consolidates hang-safety rules so they do not repeat in each prompt body. The prompt's hang-safety clause references the card: "Banned: see `__CARD_01-Robustness.md`."

The scenario: a Node.js project with a test runner, a build script, and git. The card bans commands known to hang in this stack, sets time caps per command type, and lists safe alternatives. Every implementation prompt loads this card at startup alongside `__CARD_00-Rules.md`.

## Document

`````markdown
# Robustness Card: SetupApiModule

## Banned commands

- `2>&1` with `Blocking: true` — PowerShell pipe deadlock (reading one stream to completion before the other deadlocks when the unread stream fills its pipe buffer)
- `git log` without `--no-pager` — launches pager, blocks on stdin
- `git diff` without `--no-pager` — same as above
- `git show` without `--no-pager` — same as above
- `npm install` without `--yes` or `--ci` — prompts for confirmation on stdin
- `npx <tool>` without `--yes` — prompts to install package
- `node` without a script argument — starts REPL, waits on stdin
- `Read-Host`, `pause`, `Get-Credential` — wait for stdin
- `Get-ChildItem -Recurse` on large trees — enumerates every file before returning, can hang. Use `rg.exe` instead (see Search tools below)
- `Select-String -Recurse` on large trees — same recursive enumeration problem. Use `rg.exe` instead

## Time caps

- Test suites (`npx jest`, `npx vitest`): 10 minutes
- Build scripts (`npm run build`, `node build.js`): 15 minutes
- Git operations (`git status`, `git add`, `git commit`): 2 minutes
- Type checking (`npx tsc --noEmit`): 5 minutes

## Always rules

- Test suites run with `--ci` flag (non-blocking, no watch mode)
- Git commands use `--no-pager` flag
- `npx` commands use `--yes` flag
- Stray processes stopped after every command execution
- Stderr redirected to file, not merged with `2>&1`
- File and content search uses `rg.exe` (ripgrep) instead of `Get-ChildItem -Recurse` or `Select-String -Recurse`

## On-cap behavior

When a command exceeds its time cap:
1. Kill the process tree (not just the parent process)
2. Record the command and cap in session `PROBLEMS.md`
3. Continue to the next step in the prompt

## Execution pattern

Hang-risky commands execute via `Start-Process` + `WaitForExit` with process-tree kill on timeout. This is the second tier — the first tier is the always rules above.

```powershell
function Stop-ProcessTree {
  param([int]$ProcessId)
  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }
  foreach ($child in $children) { Stop-ProcessTree -ProcessId $child.ProcessId }
  try { Stop-Process -Id $ProcessId -Force } catch {}
}

$proc = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile","-Command", "<command>" -PassThru -NoNewWindow -RedirectStandardOutput ".tmp_cmd_stdout.txt" -RedirectStandardError ".tmp_cmd_stderr.txt"
if (-not $proc.WaitForExit(<cap_ms>)) {
  Stop-ProcessTree -ProcessId $proc.Id
  Write-Host "TIMEOUT: <command> exceeded <cap> cap"
} else {
  (Get-Content ".tmp_cmd_stdout.txt" -Raw) ?? ''
}
```

Why this pattern:
- Recursive tree kill `[TESTED]` — `Stop-ProcessTree` recurses through children and grandchildren. `Stop-Job` does not.
- No pipe deadlock `[TESTED]` — stderr to file via `-RedirectStandardError`, never `2>&1`.
- Self-contained `[TESTED]` — timeout + kill + record in one block. No agent cooperation needed.
- Null-safe output `[TESTED]` — `Get-Content -Raw` returns `$null` on empty files. Use `?? ''`.
- Dead-PID safe `[TESTED]` — `try/catch` in `Stop-ProcessTree` handles processes that exit between timeout and kill.

Example: `Get-Content` with `| Select-Object -First 50` can hang on large or locked files.

Root-cause fix (tier 1): use `-TotalCount` — stops at the provider level:
```powershell
Get-Content "file.md" -TotalCount 50
```

Timeout wrapper (tier 2): when `-TotalCount` is not enough (locked file, network):
```powershell
$proc = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile","-Command", "Get-Content 'file.md' -TotalCount 50" -PassThru -NoNewWindow -RedirectStandardOutput ".tmp_gc_stdout.txt" -RedirectStandardError ".tmp_gc_stderr.txt"
if (-not $proc.WaitForExit(30000)) {
  Stop-ProcessTree -ProcessId $proc.Id
  Write-Host "TIMEOUT: Get-Content exceeded 30s cap — file may be locked"
} else {
  (Get-Content ".tmp_gc_stdout.txt" -Raw) ?? ''
}
```

## Search tools

Use `rg.exe` (ripgrep) for file and content search. Faster than `Get-ChildItem -Recurse` and never hangs on large trees.

**Locate `rg.exe`** (bundled with VS Code-based editors):

```powershell
$rg = Get-ChildItem "$env:LOCALAPPDATA\Programs\*\resources\app\node_modules\@vscode\ripgrep-universal\bin\win32-x64\rg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
```

**Grep** (content search, respects `.gitignore` by default):

```powershell
# Basic search
& $rg.FullName "TODO" "src/"
# Case-insensitive
& $rg.FullName -i "error" "src/"
# Regex pattern
& $rg.FullName "console\.log\(" "src/"
# With context (3 lines before/after)
& $rg.FullName -B 3 -A 3 "function main" "src/"
# Matching filenames only
& $rg.FullName --files-with-matches "deprecated" "src/"
# Count matches per file
& $rg.FullName --count "pattern" "src/"
# Specific file types only
& $rg.FullName -t py "import" "src/"
# Exclude file types (use -T, not -t !type)
& $rg.FullName -t py -T md "def " "src/"
# Multi-line search
& $rg.FullName -U "try\s*\{.*\}" "src/"
```

**File search** (find files by name):

```powershell
# List all files (respects .gitignore)
& $rg.FullName --files "src/"
# Filter by name pattern
& $rg.FullName --files "src/" | Select-String "config"
# Glob pattern
& $rg.FullName --files -g "*.md" "docs/"
# Exclude directories via glob
& $rg.FullName --files -g "!node_modules" "."
```

**Search without `.gitignore`** (include ignored files):

```powershell
# Search all files, including .gitignored
& $rg.FullName --no-ignore "pattern" "src/"
# Include hidden files too
& $rg.FullName --no-ignore --hidden "pattern" "src/"
# Search all but still exclude specific dirs
& $rg.FullName --no-ignore -g "!node_modules" -g "!dist" "pattern" "src/"
```

`````

## Key Decisions

- **Project-specific banned list**: The card bans commands specific to this stack (Node.js, npm, npx, git). A different project would have different entries (PRMT-HS-02).
- **Time caps per command type**: Test suites get 10 minutes, git operations get 2 minutes. The cap matches the expected duration — a 2-minute git commit is already abnormal (PRMT-HS-03).
- **Always rules for safe alternatives**: Instead of just banning, the card lists what to do instead: `--ci` for tests, `--no-pager` for git, `--yes` for npx (PRMT-HS-05).
- **On-cap behavior matches PRMT-HS-04**: Kill, record in PROBLEMS.md, continue. The card makes this explicit so every prompt follows the same protocol.
- **Card loaded at prompt startup**: Every implementation prompt reads `__CARD_01-Robustness.md` in its context-loading directive. The hang-safety clause in the prompt body references the card instead of repeating the full banned list (PRMT-HS-01).
- **Separate from CARD_00-Rules**: Robustness rules are in a dedicated card, not mixed into the operating contract. This keeps each card under the context budget.
- **Two-tier defense** `[TESTED]`: Always rules prevent hangs (tier 1: `-TotalCount`, `--no-pager`, `--ci`). Execution pattern catches the unexpected (tier 2: `Start-Process` + `WaitForExit` with process-tree kill). The card documents both tiers so prompts reference the card instead of repeating the pattern (PRMT-HS-03, PRMT-HS-04).
- **Start-Process over Start-Job** `[TESTED]`: The execution pattern uses `Start-Process` + `WaitForExit` because it kills the process tree (children included), redirects stderr to file (no pipe deadlock), and is self-contained for headless prompt sequences. `Stop-Job` does not reliably kill child processes.
- **Ripgrep over Get-ChildItem** `[TESTED]`: The card bans `Get-ChildItem -Recurse` and `Select-String -Recurse` on large trees and lists `rg.exe` as the safe alternative. Ripgrep respects `.gitignore` by default, returns results incrementally, and completes in milliseconds where `Get-ChildItem -Recurse` takes minutes or hangs. Bundled with VS Code-based editors at `[EDITOR_INSTALL]\resources\app\node_modules\@vscode\ripgrep-universal\bin\[platform]\rg.exe`.
- **Execution authority alongside robustness** (PRMT-EX-03): The robustness card is loaded alongside execution authority. The card does not repeat the execution authority constraint — prompts reference it directly in their Constraints section with "Execute without asking for confirmation". This separation prevents the card from duplicating per-prompt constraints.
