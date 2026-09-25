# Prompts Robustness Guide

Read BEFORE writing `_PROMPTS_[NN]-[Topic].md` files. Pairs with `PROMPTS_GUIDES.md` and `PROMPTS_RULES.md` (PRMT-HS-* and PRMT-RB-* rules).

## 1. Why Robustness Matters

Prompt sequences run unattended across multiple turns. Each prompt depends on the state left by prior prompts. A single failure — a hung command, a skipped prerequisite, an unrecorded glitch — propagates through every later prompt. The execution engine cannot skip a failed prompt; it either hangs, produces broken output, or silently proceeds with corrupted state.

Robustness has three pillars:

1. **Hang-prevention**: no command blocks the sequence indefinitely
2. **Findings-card mechanism**: glitches and working solutions are recorded in a findings card between prompts so later prompts can learn from earlier ones
3. **Verification depth**: verification sections catch real defects, not just "tests pass"

A well-structured prompt sequence with precise objectives, clean state flow, and verified idempotency is worthless if the agent issues a single hanging command in prompt 3 of 5, or if a test regression from prompt 2 survives until prompt 5 because nobody recorded it.

**Sources**: Harness rewrite session (2026-09-07), 5 prompt files, 25+ prompts. One hang failure (pipe deadlock) stopped the entire sequence. A dedicated findings card recorded 16 issues across 5 prompts, enabling later prompts to avoid repeating mistakes.

## 2. The Hang-Safety Clause

Every implementation prompt (any prompt that runs commands) MUST include a hang-safety clause in the Constraints section. The clause has three parts:

1. **Prohibition**: no command may wait for a key, stdin, a pager, or an unbounded child
2. **Banned list**: project-specific commands known to hang (see Section 4)
3. **Cap behavior**: what to do when a command exceeds its time cap

### Clause Template

Adapt the banned list to the project. The template below lists generic hang risks; add project-specific entries from Section 4.

```
Hang safety: no command may wait for a key, stdin, a pager, or an unbounded child. Banned: [project-specific list]. Test suites run non-blocking with a [N]-minute cap. On a cap: kill the process tree, record command and cap in PROBLEMS.md, continue.
```

### Where to Place the Clause

The hang-safety clause goes in the Constraints section of each implementation prompt, after domain-specific constraints and before the idempotency constraint. It is a negative constraint (PRMT-CT-02): it states what the agent must NOT do.

### When to Include the Clause

- **Implementation prompts** (modify files, run tests, execute builds): ALWAYS include
- **Research/analysis prompts** (read files, write findings): include if the prompt runs any commands beyond file reads
- **Pure generation prompts** (write a document from scratch, no command execution): exempt, but include if the prompt might trigger commands indirectly (e.g., `/verify` workflow call)

## 3. The Findings-Card Directive

Every prompt sequence that risks encountering problems MUST designate a findings card — a card file loaded and updated by every prompt that needs it. The card records glitches, spec-code mismatches, and unexpected findings between prompts. This is the findings-card directive.

### 3.1 Why a Findings Card Matters

Without a findings card:
- Glitches fixed in-prompt are invisible to later prompts — the same mistake repeats
- Test regressions survive multiple prompts because nobody recorded the mismatch
- Spec-code inconsistencies accumulate silently until a late prompt discovers them all at once
- The ex-post analysis is impossible — there is no record of what went wrong and how it was fixed

With a findings card:
- Each prompt records glitches it encounters and how it fixed them
- Later prompts load the findings card at startup and avoid repeating the same mistakes
- The final prompt has a complete record for ex-post analysis
- The agent builds institutional memory within the sequence

### 3.2 The Findings-Card Directive

Each prompt includes a `Findings card:` directive in the prompt body, after the hang-safety clause and before the closing protocol:

```
Findings card: Load and update `__CARD_[TOPIC]-Findings.md`. File glitches, spec-code mismatches, and unexpected findings. Read at prompt startup for unresolved entries from prior prompts.
```

The directive tells the agent which card to load and update. The card is shared across all prompts in the sequence. Every prompt loads it at startup and appends to it at end-of-prompt; no prompt creates a new findings card.

### 3.3 The Findings Card Format

The findings card follows a structured format. Each entry records one glitch:

```
### [N]. [Glitch Title]

**Severity**: HIGH | MEDIUM | LOW

**Expected state** (from prompt [step ID], line [N]): "[what the prompt expected]"

**Actual state**: "[what actually happened]"

**Root cause**: "[why it happened]"

**Resolution**: "[how it was fixed]" or "[not fixed — see PROBLEMS.md entry]"

**Prevention**: "[how to prevent this in future prompts]"
```

### 3.4 What to File

File every glitch, not just blockers. The findings card is separate from session PROBLEMS.md:
- **Test failures** that required code changes to fix (record the test file and the mismatch)
- **Spec-code mismatches** where the spec said one thing and the code did another
- **Naming convention violations** caught by `tsc` or lint
- **STRUT sequencing violations** where a step was executed out of order
- **Hangs and timeouts** (also recorded in PROBLEMS.md, but the findings-card entry captures root cause)
- **Test expectation drift** where a test was written before the implementation and needed updating
- **Unexpected findings** that are not defects but affect later prompts (e.g., a file is larger than expected, a dependency is missing)

### 3.5 Findings Card vs Session PROBLEMS.md

The findings card and session PROBLEMS.md serve different purposes:

- **Findings card** (`__CARD_[TOPIC]-Findings.md`): Captures ALL glitches (including those fixed in-prompt), root causes, resolutions, prevention notes. Loaded and updated by every prompt. This is a card, not a session file.
- **Session PROBLEMS.md**: Records problems encountered during prompt execution that must be approached later — blockers that stopped a prompt, deferred issues that could not be fixed in-prompt, timeouts that require investigation. PROBLEMS.md is for problems needing later attention, not detailed glitch logs.

### 3.6 How Later Prompts Use the Findings Card

Each prompt loads the findings card at startup, after reading the session cards. The agent checks:

1. Are there unresolved glitches from prior prompts that affect this prompt's work?
2. Are there prevention notes that apply to this prompt's commands or verifications?
3. Are there naming conventions or test patterns that this prompt must follow?

The read is lightweight — scan titles and prevention notes, not full entries. Full entries are read only when a title matches the current prompt's scope.

### 3.7 Integration with the Card System

When a prompt sequence uses a card system (compact context documents read at the start of each prompt), the findings card is one of the cards loaded at startup:

**Card 00 Section 3 (resume detection)** already reads PROGRESS.md to check if a step is done. Add a step: load the findings card for unresolved entries from prior prompts.

**Card 00 Section 4 (end-of-prompt protocol)** already commits and records blockers in PROBLEMS.md. Add a step: file glitches and findings in the findings card before the commit. PROBLEMS.md records blockers that stopped the prompt; the findings card captures everything notable that happened.

The card system reference:

```
## 3. Start-of-prompt protocol (resume detection)

1. Read this card and the cards the prompt names
2. Read session PROGRESS.md "Done" section. If the prompt's STRUT step ID is already listed as done: verify its artifacts exist, report "step already done", and stop. If the step is not listed as done, verify that artifacts from the prior step exist on disk before starting new work. Checkbox state alone is insufficient — deleted or missing artifacts mean the step must be redone.
3. Read the STRUT step line and unit block; read the clause-map rows
4. Load `__CARD_[TOPIC]-Findings.md` for unresolved entries from prior prompts
5. Run git status --short in both repos; uncommitted work from a previous, interrupted prompt is finished or reverted before new work starts
6. This prompt has execution authority (PRMT-EX-03). Do not ask for confirmation before executing. Execute within the Constraints section boundaries.

## 4. End-of-prompt protocol

1. Verification named in the prompt passed
2. File glitches and findings in `__CARD_[TOPIC]-Findings.md`
3. Mark the STRUT step [ ] -> [x] in __STRUT_[TOPIC].md
4. Append one line to session PROGRESS.md "Done"
5. Record blockers in session PROBLEMS.md
6. Commit both repos where changed
```

### 3.8 Findings-Card Directive Examples

**Minimal** (simple sequence, no build tools):
```
Findings card: Load and update `__CARD_[TOPIC]-Findings.md`. File glitches, spec-code mismatches, and unexpected findings. Read at prompt startup for unresolved entries from prior prompts.
```

**Full** (complex sequence with cards):
```
Findings card: Load and update `__CARD_[TOPIC]-Findings.md`. File every test failure that required a code fix, every spec-code mismatch, every naming convention violation, and every STRUT sequencing issue. Read the card at prompt startup for unresolved entries from prior prompts.
```

## 4. Command-Specific Hang Risks

### 4.1 Generic Hang Risks (All Projects)

These commands hang in any project. The banned list should always include them unless the prompt explicitly requires and safeguards them.

**Interactive prompts**:
- `Read-Host`, `pause`, `Get-Credential` (PowerShell) — wait for stdin
- `read`, `select` (bash) — wait for stdin
- Any CLI tool launched without `--non-interactive`, `--yes`, or equivalent flag

**Pagers**:
- `git log`, `git diff`, `git show`, `git blame` without `--no-pager` — launch a pager
- `less`, `more`, `man` — launch a pager
- `Get-Content -Wait`, `tail -f` — stream indefinitely

**Unbounded children**:
- `bun --watch`, `bun test --watch`, `npm run dev`, any `--watch` flag — never terminate
- `Start-Process` of an editor, browser, or console window — opens a GUI, never returns
- `Wait-Process` without `-Timeout` — waits forever if the process hangs

**Approval pipelines**:
- Sequential `run_command` calls where each requires user approval — the agent appears frozen between commands. Batch related commands into a single script or warn the user that multiple approvals will follow

### 4.2 PowerShell-Specific Risks

- `2>&1` with `Blocking: true` in the terminal tool — PowerShell stream merge creates a pipe deadlock. The process exits but the merged buffer never drains. Use `Blocking: false` or drop `2>&1`. For capturing stderr, redirect to a file (`2>err.txt`) and read it after
- `Invoke-WebRequest` without `-UseBasicParsing` — may launch IE component on older systems
- `Start-Job` without `Wait-Job -Timeout` — job runs indefinitely
- `Get-ChildItem -Recurse` on large directory trees — enumerates every file before returning, can take minutes or hang on network shares. Use `rg.exe` instead (see Section 5.6)
- `Select-String -Path *.md -Recurse` on large trees — same recursive enumeration problem. Use `rg.exe` instead

### 4.3 Build Tool Risks

- `build.bat`, `ship.bat` — often contain `pause` at the end
- `build.ps1` without `-NonInteractive` — may call `Read-Host` or `ReadKey`
- `npm install` without `--yes` or `--no-audit` — may prompt for audit, fund, or peer dependency resolution
- `bunx`, `npx` — may prompt to install a package

### 4.4 Test Runner Risks

- Test suites without `--timeout` — a hanging test hangs the entire suite
- `bun test` without `--timeout` — default timeout may be too long or absent
- Integration tests that spawn processes without per-test timeouts and `afterEach` cleanup — orphaned processes accumulate

### 4.5 Git Risks

- `git commit` without `-m` — opens an editor
- `git rebase -i` — opens an editor
- `git push` — may wait for credentials
- `git log`, `git diff`, `git show`, `git blame` without `--no-pager` — launch a pager

## 5. Safe Command Patterns

### 5.1 Non-Blocking Execution with Caps

Run commands non-blocking (if the terminal tool supports it) and poll for completion with a time cap:

```
Run the test suite as `bun test --timeout 20000 tests/unit tests/integration` non-blocking with a 10-minute cap. Poll for completion. On cap: stop the process tree, record command and cap in PROBLEMS.md, continue.
```

### 5.2 Process Cleanup

After any command that spawns processes, verify no orphans remain:

```
After every suite run: `Get-Process [process-name]* -ErrorAction SilentlyContinue` must return nothing. Orphans are stopped and their count goes into the PROGRESS.md line.
```

### 5.3 Git Commands

Always use `--no-pager` and `-n <N>` for log:

```
git --no-pager log -n 20
git --no-pager diff
git --no-pager show HEAD
```

### 5.4 Build Commands

Always use non-interactive flags:

```
pwsh -NoProfile -File build.ps1 -NonInteractive
npm install --yes --no-audit
```

### 5.5 Redirecting stderr

Never use `2>&1` with blocking execution. Redirect to a file instead:

```
bun test --timeout 20000 2>err.txt
# Read err.txt after completion
```

### 5.6 Ripgrep for Search Operations

For grepping and file search in large folder structures, use `rg.exe` (ripgrep) instead of `Get-ChildItem -Recurse`, `Select-String -Recurse`, or `Get-Content` pipelines. Ripgrep is a fast, non-hanging search tool that:

- Respects `.gitignore` by default (no scanning `node_modules`, `bin`, `dist`)
- Returns results incrementally (no full enumeration before output)
- Handles binary files gracefully (skips them, never hangs)
- Completes in milliseconds where `Get-ChildItem -Recurse` takes minutes

`rg.exe` is bundled with VS Code-based editors (Devin, Cursor, etc.) at `[EDITOR_INSTALL]\resources\app\node_modules\@vscode\ripgrep-universal\bin\[platform]\rg.exe` where `[platform]` is `win32-x64`, `darwin-x64`, `darwin-arm64`, or `linux-x64`.

**Why not `Get-ChildItem -Recurse`**: PowerShell's `Get-ChildItem -Recurse` enumerates every file in the tree before returning results. On large projects (10k+ files) or network shares, this can take minutes or hang. `Select-String -Recurse` has the same problem — it enumerates first, then searches. Ripgrep walks the tree lazily and returns matches as it finds them.

For full usage examples (grep, file search, ignoring `.gitignore`), see `PROMPTS_EXAMPLE_02-RobustnessCard.md` Section "Search tools".

### 5.7 Agent Tools Over Shell Commands for File Operations

Prompts must direct the agent to use built-in tools (grep_search, read_file, find_by_name, code_search) for file search, read, and list operations (PRMT-CT-12). Shell commands for file operations are a hang source and bypass the agent's file access layer.

**Why this is a robustness concern**: Shell commands like `Get-ChildItem -Recurse`, `Select-String -Recurse`, and `Get-Content` were primary hang sources in a Lana-V2-Dev session. `Get-ChildItem -Recurse` on large trees enumerates every file before returning. `Select-String -Recurse` has the same problem. `Get-Content -Wait` streams indefinitely. Agent built-in tools are non-hanging by design.

**Rule**: Shell commands (Select-String, Get-ChildItem, Get-Content, cat, grep, find, rg.exe) must not appear in prompt bodies for file exploration or reading. They may appear in Verify sections for residual sweeps and explicit command-based checks only.

**Prompt body — use agent tool directives**:
```
Search for 'validateToken' in src/ using the grep_search tool.
Read `src/auth/validator.ts`.
Find all .ts files in src/ using the find_by_name tool.
```

**Verify section — shell commands acceptable for residual sweeps**:
```
Verify: `Select-String -Pattern 'guard_request' -Path src/` returns zero matches.
```

## 6. Timeout and Cap Patterns

### 6.1 Setting Caps

Every command that runs a process gets a time cap. The cap depends on the command type:

- **Single test file**: 3-minute cap
- **Full test suite**: 10-minute cap
- **Build**: 15-minute cap
- **Headless application run**: 3-minute cap
- **Git operations**: 30-second cap (most operations complete in seconds)

**Heuristic**: Set the cap to roughly 3x the command's average duration. If a test suite normally runs in 8 minutes, set the cap to 25 minutes. This gives headroom for slow runs without letting a hung process run indefinitely.

### 6.2 On-Cap Behavior

When a command hits its cap:

1. Send SIGTERM (graceful stop request) — `Stop-Process -Id <pid> -Force` on Windows, `kill -TERM <pid>` on POSIX
2. Wait 5 seconds for the process to exit cleanly
3. If still running, send SIGKILL (force-kill, cannot be caught) — `taskkill /T /F /PID <pid>` on Windows, `kill -KILL <pid>` on POSIX
4. Kill any project-specific orphan processes by name
5. Record the command, the cap, and the last output lines in PROBLEMS.md
6. Continue with the next step of the prompt — never re-run the same command blocking
7. If the same command hangs twice, stop the prompt with a PROBLEMS.md entry

**Why escalation**: SIGTERM gives the process a chance to clean up (flush buffers, release locks, write state). SIGKILL is immediate and cannot be caught — the process gets no cleanup opportunity. Direct SIGKILL can leave resources locked, files half-written, and ports in a dirty state. The `timeout` command uses this exact pattern: SIGTERM first, then SIGKILL after a grace period.

### 6.3 Per-Test Timeouts

Tests that spawn processes must set explicit per-test timeouts and kill their process tree in `afterEach`:

```
New tests that spawn processes set an explicit per-test timeout and kill their process tree in afterEach. A spawning test without both is a defect to fix in the same prompt.
```

### 6.4 Targeted Test Scope

Verification sections must run specific test files, not the full test suite, during implementation steps (PRMT-HS-09). Full test suite runs are reserved for final verification steps only.

**Why targeted scope matters**: A Lana-V2-Dev session documented the full `bun test` suite hanging indefinitely, while targeted test files completed in seconds. The full suite includes long-running integration tests, timing-dependent tests, and process-spawning tests that may not terminate cleanly. Another session documented a flaky test that failed in the full suite but passed in isolation due to timing pressure from other tests in the same run.

**Implementation prompts — run specific test files**:
```
Verify: Run `bun test tests/unit/auth.test.ts tests/unit/token_validator.test.ts`. All tests pass.
```

**Final verification — full suite acceptable with cap**:
```
Verify: Run `bun test --timeout 20000` non-blocking with a 10-minute cap. All tests pass.
```

**Rule**: Bare `bun test` or `npm test` (full suite) in implementation prompt verification is a PRMT-HS-09 violation. Always scope to specific test files during implementation. Full suite only in the final verification step of a sequence.

## 7. Verification Gap Prevention

Beyond hangs and problem filing, verification gaps silently pass as "done." Include these in prompt verification sections to prevent false "done" claims:

### 7.1 Test Coverage Depth

Do not accept "tests pass" when the prompt required specific test scenarios. Verify that the specific scenarios exist, not just that the suite is green:

```
Verify: tests/integration/harness.test.ts contains test cases for [specific scenario A], [specific scenario B]. All tests pass.
```

### 7.2 Spec-Code Consistency

When a prompt amends specs and implements code, verify both directions:

```
Verify: spec FR-03 text matches code implementation. Run `bun tsc --noEmit` — no type errors.
```

### 7.3 Residual Sweeps

When a prompt removes concepts (old protocol, old naming), include a residual sweep:

```
Verify: `Select-String -Pattern 'old_term'` returns zero matches in src/ and outside Document History in specs.
```

### 7.4 Naming Convention Checks

When a prompt introduces new naming conventions, verify consistency:

```
Verify: no camelCase variants of [snake_case_field] exist in src/. Run `bun tsc --noEmit` — no type errors.
```

### 7.5 Prior-Step Confirmation

When a prompt depends on a prior step, verify the prior step is done:

```
Verify: Confirm STRUT step [prior step ID] is `[x]` in [STRUT filename].
```

### 7.6 Interleaved Verification Prompts as Drift Prevention

Sequences with 4 or more implementation prompts must include interleaved verification prompts every 2-3 implementation prompts (PRMT-SQ-04). These are verification-only prompts that run `/verify` against the planning document and `/fix` to address gaps — not implementation prompts with verification sections.

**Why this is a robustness concern**: Without interleaved checkpoints, spec-code drift accumulates silently. A Lana-V2-Dev SecurityRemediation sequence had 5 sub-chains where drift was only caught at the end, requiring rework across the full sequence. Interleaved verification limits blast radius to 2-3 prompts.

**Verification prompt template**:
```
Read `__CARD_00-Rules.md` and `__STRUT_[Topic].md`. Treat earlier conversation as compacted. Verification checkpoint after prompts [N]-[M].

/verify

current state against `__STRUT_[Topic].md` for prompts executed so far.

/fix

all gaps and remaining work.
```

**Key properties**:
- Self-contained opening reads rules card and planning document (PRMT-SC-01)
- `/verify` and `/fix` are standalone workflow calls (PRMT-CT-08)
- No implementation content — no code, tests, or builds
- Does NOT count toward chain length limit (PRMT-SC-04)
- Heading: `## Verification Checkpoint N` (not `## Prompt N`)

## 8. Project-Specific Banned Lists

The hang-safety clause needs a project-specific banned list. Build it by scanning the project for commands that wait on stdin, launch pagers, or run unbounded children.

### 8.1 How to Build the Banned List

1. Search the project for scripts containing `pause`, `Read-Host`, `ReadKey`, `Get-Credential`
2. Search for CLI entry points that read stdin when no arguments are provided
3. Search for `--watch` flags in package.json scripts
4. Search for `.bat` files (often contain `pause`)
5. Test each suspicious command with a 5-second timeout — if it hangs, add it to the banned list

### 8.2 Banned List Format in Prompts

List banned commands by their invocation pattern, not by filename:

```
Banned: build.bat, ship.bat (contain pause); app.exe without -p or --prompt-file (interactive console); bun --watch (never terminates); 2>&1 with Blocking:true (pipe deadlock)
```

### 8.3 Always-Rules

After the banned list, include "always" rules for safe alternatives:

```
Always: test suites run as `bun test --timeout 20000` non-blocking with 10-minute cap; builds run as `pwsh -NoProfile -File build.ps1 -NonInteractive`; git commands use `--no-pager`; stray processes stopped after every run.
```

## 9. Lessons from a Harness Rewrite Session

A harness rewrite session (2026-09-07) used 5 prompt files with 25+ prompts. One hang failure and several verification gaps occurred despite the hang-safety system. A dedicated findings card recorded 16 issues across 5 prompts.

### 9.1 The `2>&1` Hang (Pipe Deadlock)

**What**: `bun test --timeout 20000 tests/unit/prompt_assemble.test.ts 2>&1` with `Blocking: true` caused an indefinite hang. The same command without `2>&1` completed in 182ms.

**Root cause**: PowerShell `2>&1` merges stderr into stdout at the OS pipe level. The terminal tool reads stdout to completion before returning, but the merged stream's buffering behavior creates a deadlock where the process has exited but the pipe buffer is not fully drained. This is a well-documented Windows pipe deadlock pattern: reading one stream to completion before starting the other deadlocks when the unread stream fills its pipe buffer.

**Prevention**: The banned list must include `2>&1` with `Blocking: true`. For capturing stderr, redirect to a file.

### 9.2 STRUT Sequencing Violation

**What**: P3-S4 (spec amendments) was skipped, P3-S5 (implementation) was executed without spec backing. The STRUT showed P3-S4 as `[ ]` and P3-S5 as `[x]`.

**Root cause**: The prompt sequence did not enforce a gate between P3-S4 and P3-S5. The agent proceeded to implementation without the spec prerequisite.

**Prevention**: Prompts that depend on prior steps must verify the prior step is done. Include in the Verify section: "Confirm STRUT step [prior step ID] is `[x]` in [STRUT filename]."

### 9.3 Test Regression Survived 3 Prompts

**What**: P3-S3 changed prompt text in source code. The corresponding test was not updated. The failure was not caught until P3-S6 — three prompts later.

**Root cause**: P3-S3's verification said "bun test green" but did not name the specific test file that would be affected by the text change.

**Prevention**: When a prompt changes code that has associated tests, name the test file in the Verify section: "Run `bun test tests/unit/prompt_assemble.test.ts`. All tests pass."

### 9.4 Spec-Code Type Mismatch

**What**: Spec 14 example showed `origin_refs` as `[{kind, ref}]` (objects) but code implements `string[]`. The spec example was written before the FR was refined.

**Root cause**: The spec example was not updated when the FR text was refined in a later prompt.

**Prevention**: When a prompt refines a spec FR, include in the Verify section: "Spec examples at [section] match the refined FR text."

### 9.5 Property Naming Convention Mismatch

**What**: Code used `runCtx` (camelCase) but the spec and Gate class use `run_ctx` (snake_case). `tsc` caught it immediately.

**Root cause**: TypeScript convention (camelCase) conflicted with the harness naming convention (snake_case). The agent defaulted to TypeScript convention.

**Prevention**: When a prompt introduces naming conventions, include the convention in the Constraints section: "Use snake_case for all harness field names, not TypeScript camelCase."

### 9.6 What the Findings Card Caught

The findings card recorded all 16 issues above. Later prompts loaded it and:

- Avoided the `2>&1` pattern (banned in card 00 Section 12 after the first hang)
- Caught spec-code mismatches earlier by checking the findings card before verification
- Followed the naming convention after reading the mismatch entry
- Backfilled the skipped STRUT step after reading the sequencing violation entry

Without the card, these issues would have been discovered only at the final validation — too late to fix without re-running earlier prompts.

## 10. Robustness Clause Examples

### 10.1 Minimal Clause (Simple Project)

```
Hang safety: no command may wait for stdin, a pager, or an unbounded child. Banned: git log without --no-pager, npm install without --yes. Test suites run with a 5-minute cap. On cap: kill, record in PROBLEMS.md, continue.

Findings card: Load and update `__CARD_[TOPIC]-Findings.md`. File glitches, spec-code mismatches, and unexpected findings. Read at prompt startup for unresolved entries from prior prompts.
```

### 10.2 Full Clause (Complex Project with Build Tools and Cards)

```
Hang safety: no command may wait for a key, stdin, a pager, or an unbounded child. Banned: build.bat, ship.bat (contain pause); app.exe without -p or --prompt-file (interactive console); bun --watch (never terminates); 2>&1 with Blocking:true (pipe deadlock); git log without --no-pager; Read-Host, pause, Get-Credential. Always: test suites run as `bun test --timeout 20000` non-blocking with 10-minute cap; builds run as `pwsh -NoProfile -File build.ps1 -NonInteractive`; git commands use `--no-pager`; stray processes stopped after every run. On a cap: stop the process tree, record command and cap in PROBLEMS.md, continue.

Findings card: Load and update `__CARD_[TOPIC]-Findings.md`. File every test failure that required a code fix, every spec-code mismatch, every naming convention violation, and every STRUT sequencing issue. Read the card at prompt startup for unresolved entries from prior prompts.
```

### 10.3 Clause for a Research Prompt (No Builds)

```
Hang safety: no command may wait for stdin or a pager. Banned: git log without --no-pager. File reads use `read_file` tool, not `Get-Content -Wait`.

Findings card: Load and update `__CARD_[TOPIC]-Findings.md`. File unexpected findings for later prompts.
```

## 11. Timeout Execution Pattern

When a command has no native safe parameter (e.g., `Get-Content` on a large or locked file), wrap it in a separate process with a timeout. This is the safety net below the always rules — it catches hangs that the banned list and safe alternatives don't prevent.

### 11.1 Standard Pattern: Start-Process + WaitForExit

This is the most robust pattern for prompt sequences. It runs the command in a separate process, redirects stderr to a file (no pipe deadlock), and kills the process tree on timeout.

**Helper function** (define once at top of prompt or in robustness card):

```powershell
function Stop-ProcessTree {
  param([int]$ProcessId)
  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }
  foreach ($child in $children) { Stop-ProcessTree -ProcessId $child.ProcessId }
  try { Stop-Process -Id $ProcessId -Force } catch {}
}
```

**Timeout wrapper**:

```powershell
$proc = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile","-Command", "<command>" -PassThru -NoNewWindow -RedirectStandardOutput ".tmp_cmd_stdout.txt" -RedirectStandardError ".tmp_cmd_stderr.txt"
if (-not $proc.WaitForExit(<cap_ms>)) {
  Stop-ProcessTree -ProcessId $proc.Id
  Write-Host "TIMEOUT: <command> exceeded <cap> cap"
} else {
  (Get-Content ".tmp_cmd_stdout.txt" -Raw) ?? ''
}
```

### 11.2 Why This Pattern

- **Recursive process tree kill** `[TESTED]`: `Stop-ProcessTree` recurses through children and grandchildren. `Stop-Job` does not kill children. A flat `Get-CimInstance` query only gets direct children — grandchildren survive.
- **No pipe deadlock** `[TESTED]`: stderr goes to file via `-RedirectStandardError`, never merged with `2>&1` (see Section 5.5 for the principle).
- **Self-contained** `[TESTED]`: timeout + kill + record happens in one block. No agent cooperation needed. Works in headless prompt sequences.
- **Separate process isolation** `[TESTED]`: if the command hangs, the main session is not blocked.
- **Null-safe output** `[TESTED]`: `Get-Content -Raw` returns `$null` on empty files (e.g., command produced no stdout). Use `?? ''` to avoid method-call-on-null errors.
- **Dead-PID safe** `[TESTED]`: `Stop-ProcessTree` wraps `Stop-Process` in `try/catch` — if the process already exited between the timeout check and the kill, no crash.
- **Direct kill, no SIGTERM escalation**: unlike Section 6.2's general on-cap pattern (SIGTERM → wait 5s → SIGKILL), the timeout pattern kills immediately with `Stop-Process -Force` (PowerShell equivalent of `taskkill /T /F`). Rationale: the process is already hung — a 5-second grace period only delays the inevitable and risks re-hang on cleanup.

### 11.3 Two-Tier Defense

The timeout pattern is the **second tier**. The first tier is the always rules in the robustness card:

1. **Always rules** (prevent the hang): use `-TotalCount` for `Get-Content`, `--no-pager` for git, `--ci` for jest, `--yes` for npx
2. **Timeout cap** (catch the unexpected): wrap commands that have no native safe parameter, or where the safe parameter might not be enough (locked files, network hangs)

### 11.4 Example: Get-Content Hang

`Get-Content` with `| Select-Object -First 50` can hang on large or locked files because the pipeline buffers internally before `Select-Object` can signal "stop".

**Root-cause fix** (tier 1): use `-TotalCount` — stops reading at the provider level:
```powershell
Get-Content "file.md" -TotalCount 50
```

**Timeout wrapper** (tier 2): when `-TotalCount` is not available or the file might be locked:
```powershell
$proc = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile","-Command", "Get-Content 'file.md' -TotalCount 50" -PassThru -NoNewWindow -RedirectStandardOutput ".tmp_gc_stdout.txt" -RedirectStandardError ".tmp_gc_stderr.txt"
if (-not $proc.WaitForExit(30000)) {
  Stop-ProcessTree -ProcessId $proc.Id
  Write-Host "TIMEOUT: Get-Content exceeded 30s cap — file may be locked"
} else {
  (Get-Content ".tmp_gc_stdout.txt" -Raw) ?? ''
}
```

### 11.5 Gotchas `[TESTED]`

- **Quote escaping** `[TESTED]`: `Start-Process -ArgumentList` strips double quotes inside the `-Command` string. Use single quotes for string literals inside the command: `'Get-Content ''file.md'' -TotalCount 50'` (doubled single quotes in single-quoted strings).
- **Write-Error vs stderr** `[TESTED]`: PowerShell `Write-Error` writes to the error stream, not OS stderr. `[Console]::Error.WriteLine()` writes to actual stderr (captured by `-RedirectStandardError`).
- **Orphaned children** `[TESTED]`: when a parent exits fast (e.g., `cmd /c start /b pwsh ...`), children become orphaned — their parent PID no longer maps to a running process. `Stop-ProcessTree` cannot find them. After killing the tree, sweep for survivors by command-line pattern: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*<pattern>*' }` and kill them.
- **Empty output files** `[TESTED]`: `Get-Content -Raw` on an empty file returns `$null`, not `''`. Always use `?? ''` before calling `.Trim()` or other string methods.

### 11.6 Pattern in the Robustness Card

The robustness card includes the timeout pattern in an `Execution pattern` section so prompts reference it instead of repeating the full PowerShell block:

```markdown
## Execution pattern

Hang-risky commands execute via Start-Process + WaitForExit with process-tree kill on timeout. See timeout pattern in this card. Time caps per command type listed above.
```

The prompt's hang-safety clause references this: "Hang-risky commands use the timeout pattern from `__CARD_01-Robustness.md`."

## 12. Review Checklist

Before considering a prompt file complete, verify robustness:

**Hang-safety**:
- [ ] Every implementation prompt includes a hang-safety clause (PRMT-HS-01)
- [ ] The clause names project-specific banned commands (PRMT-HS-02)
- [ ] The clause specifies time caps for command execution (PRMT-HS-03)
- [ ] The clause specifies on-cap behavior: kill, record, continue (PRMT-HS-04)
- [ ] The clause specifies process cleanup after command execution (PRMT-HS-05)
- [ ] No prompt contains a bare `2>&1` without noting the `Blocking: false` requirement (PRMT-HS-06)
- [ ] No prompt contains `git log`, `git diff`, `git show` without `--no-pager` (PRMT-HS-06)
- [ ] Hang-risky commands without native safe parameters use the Start-Process + WaitForExit timeout pattern (PRMT-HS-03)
- [ ] No shell commands for file search/read in prompt bodies — agent tools only (PRMT-CT-12)
- [ ] Document History timestamps use request metadata, not extrapolated times (PRMT-CT-13)
- [ ] Banned-term sweep recordings describe pattern shape, do not spell banned literals (PRMT-CT-14)
- [ ] Verification runs specific test files, not full suite, during implementation steps (PRMT-HS-09)
- [ ] Verify section checks spec-code consistency when prompt changes code with associated spec (PRMT-HS-10)
- [ ] Sequences with 4+ implementation prompts include interleaved verification prompts every 2-3 prompts (PRMT-SQ-04)
- [ ] Every implementation prompt includes "Execute without asking for confirmation" in Constraints (PRMT-EX-03)

**Verification depth**:
- [ ] Verification sections name specific test files when code changes affect tests (PRMT-HS-07)
- [ ] Verification sections include residual sweeps when concepts are removed (PRMT-HS-07)
- [ ] Prompts that depend on prior steps verify the prior step is done (PRMT-HS-08)

**Findings card**:
- [ ] The prompt sequence designates a findings card (PRMT-RB-01)
- [ ] Every implementation prompt includes a Findings card directive pointing to the card (PRMT-RB-02)
- [ ] The findings card is loaded at prompt startup for unresolved entries from prior prompts (PRMT-RB-03)
- [ ] Glitches are filed in the findings card before the end-of-prompt commit (PRMT-RB-04)
- [ ] Each glitch entry records: what, expected, actual, root cause, resolution, prevention (PRMT-RB-05)
- [ ] The card system end-of-prompt protocol includes a findings-card update step (PRMT-RB-06)
- [ ] Session PROBLEMS.md records deferred problems, not detailed glitch logs (PRMT-RB-07)

## 13. Example Files

Worked examples for card types referenced in this guide:

- `PROMPTS_EXAMPLE_02-RobustnessCard.md` — complete `__CARD_01-Robustness.md` with banned commands, time caps, always rules, on-cap behavior
- `PROMPTS_EXAMPLE_03-FindingsCard.md` — complete `__CARD_[TOPIC]-Findings.md` with resolved glitches, unresolved blocker, six-field entry format

Load these when authoring cards for a new prompt sequence. The examples are not mandatory reads — load them when unfamiliar with card structure or when a sequence has complex robustness requirements.
