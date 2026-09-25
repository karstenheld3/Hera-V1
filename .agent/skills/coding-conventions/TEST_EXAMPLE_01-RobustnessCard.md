# Test Example 01: Robustness Card

Demonstrates a robustness card for test execution in agentic prompt sequences. Every implementation prompt loads this card to prevent agent hangs, process leaks, and unbounded execution.

## Context

An agentic workflow runs a test suite of 150+ tests across 16 categories. Tests spawn subprocesses, make mock HTTP calls, and write to disk. Without explicit hang prevention, agents wait indefinitely on stuck commands, burning API tokens on idle context windows.

The robustness card is a standalone document referenced by every prompt's hang-safety clause. It encodes four sections: banned commands, always rules, time caps, and on-cap behaviour.

## Document

```markdown
# Card: Robustness for [PROJECT] Prompt Sequences

Hang prevention, banned commands, time caps. Referenced by every implementation prompt.

## Banned

- `| Select-Object` on test or product run output (buffers indefinitely, appears to hang)
- `Read-Host`, `pause`, `Get-Credential`, `Get-Content -Wait` (wait on stdin or stream forever)
- `git log`, `git diff`, `git show` without `--no-pager`; `git commit` without `-m`
- `2>&1` combined with blocking execution (PowerShell pipe deadlock); redirect stderr to a file instead
- `pytest` without a file scope in implementation prompts (full suite only in final verification)
- `pytest -m nightly` outside the final verification phase
- Any live API call in implementation phases (mock transport only)

## Always

- Tests: `[PYTHON] -m pytest <files> -q -x --no-header -p no:cacheprovider` non-blocking
- Single file: 3 min cap; full suite: 15 min cap; nightly: 30 min cap
- Git: `git --no-pager ...`; `git push` 60 s cap
- After every test or product run: `Get-Process python* -ErrorAction SilentlyContinue` filtered to
  the venv path returns nothing; strays are stopped and counted in the findings card

## On Cap

1. `Stop-Process -Id <pid> -Force`; wait 5 s; if alive, `taskkill /T /F /PID <pid>`
2. Sweep survivors by command line (`Win32_Process` where `CommandLine` contains `pytest` or product name)
3. Record command, cap, last 20 output lines in session `PROBLEMS.md`
4. Continue with the next step; never re-run the same command blocking
5. Same command hits the cap twice: stop the prompt, `PROBLEMS.md` entry, status `blocked`

## Execution Pattern

Hang-risky commands (product runs, full suites, live calls) execute via
`Start-Process -PassThru -NoNewWindow -RedirectStandardOutput <file> -RedirectStandardError <file>`
followed by `WaitForExit(<cap_ms>)`; on timeout kill the process tree recursively (children first).
Output files use `.tmp_*` prefix under `[SESSION_FOLDER]` and are deleted by the prompt that created them.

## Default Test Command

- **CWD**: `[SKILL_FOLDER]`
- **Python**: `[PYTHON]`
- **Command**: `python -m pytest tests/ --no-header -p no:cacheprovider -q -n auto`
- `-n auto` uses all CPU cores via pytest-xdist
- Do NOT pipe output through `| Select-Object` - it buffers and appears to hang
```

## Key Decisions

- **Four fixed sections (Banned, Always, On Cap, Execution Pattern)**: Every robustness card follows the same structure. Agents know where to find each type of constraint without reading the whole card.
- **Banned commands are stack-specific**: Each project adds its own banned commands based on observed hangs. The examples above are PowerShell/pytest-specific. A Node.js project would ban different commands.
- **Time caps are per-command-type, not global**: A single 15-min global cap would be too loose for git operations and too tight for nightly tests. Per-type caps give precise boundaries.
- **On-cap escalation (kill then sweep then record)**: The three-step on-cap procedure ensures no orphan processes survive. Recording in PROBLEMS.md creates traceability. The "twice = blocked" rule prevents infinite retry loops.
- **Default test command recorded once**: Every prompt uses the same invocation from this card. No drift between prompts on flag usage.
- **Generic placeholders `[PYTHON]`, `[SKILL_FOLDER]`, `[SESSION_FOLDER]`**: The card uses workspace constants so it works across environments without hardcoded paths.
