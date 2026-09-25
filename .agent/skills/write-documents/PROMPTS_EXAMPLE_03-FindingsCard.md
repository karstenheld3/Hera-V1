# Prompts Example 03: Findings Card

Demonstrates a complete `__CARD_[TOPIC]-Findings.md` with example glitch entries showing resolved issues, an unresolved blocker, and the distinction between findings card and session PROBLEMS.md.

## Context

This example shows a findings card mid-sequence — after prompts 1 and 2 have run, before prompt 3 starts. The card contains two resolved glitches (fixed in-prompt), one unresolved issue (deferred to PROBLEMS.md), and demonstrates the six-field entry format.

The scenario: a 3-prompt sequence implementing a REST API module. Prompt 1 analyzed requirements, prompt 2 implemented the module, prompt 3 will write tests. The findings card was created at sequence start and updated after each prompt. Prompt 3 loads this card at startup to check for unresolved entries affecting the test-writing scope.

## Document

`````markdown
# Findings Card: SetupApiModule

## Unresolved

### 1. Missing dependency blocks integration test

**Severity**: MEDIUM

**Expected state** (from prompt P2-S1, line 14): "Integration tests pass with `npx jest tests/integration/`"

**Actual state**: `jest` exits with error — `@api/sdk` package not installed. Cannot install in-prompt without network access.

**Root cause**: Package was added to `package.json` in P2-S1 but never installed. The CI environment has no network during prompt execution.

**Resolution**: Not fixed — see PROBLEMS.md entry SETUPAPI-PR-0001. Workaround: unit tests only in P3-S1, integration tests deferred.

**Prevention**: Add `npm install --offline` to the start-of-prompt protocol when `package.json` changes are introduced.

## Resolved

### 2. Pipe deadlock on test suite

**Severity**: HIGH

**Expected state** (from prompt P2-S1, line 22): "Run `npx jest --ci tests/unit/auth.test.ts 2>&1` with Blocking: true"

**Actual state**: Command hung indefinitely. Same command without `2>&1` completed in 3.2 seconds.

**Root cause**: PowerShell `2>&1` merges stderr into stdout at the OS pipe level. Reading one stream to completion before the other deadlocks when the unread stream fills its pipe buffer.

**Resolution**: Removed `2>&1`, redirected stderr to a temp file. Added `2>&1` with `Blocking: true` to banned list in `__CARD_01-Robustness.md`.

**Prevention**: Never use `2>&1` with `Blocking: true`. Redirect stderr to a file instead. This rule is now in the robustness card.

### 3. Naming convention mismatch

**Severity**: LOW

**Expected state** (from prompt P2-S1, line 8): "Use snake_case for all API response field names"

**Actual state**: Code used `createdAt` (camelCase). `tsc` caught it immediately — type error on the response interface.

**Root cause**: TypeScript convention (camelCase) conflicted with the API design spec (snake_case). The agent defaulted to TypeScript convention.

**Resolution**: Renamed to `created_at` in `src/modules/users/routes.ts` line 47. Added the convention to Constraints in the prompt: "Use snake_case for all API response field names, not TypeScript camelCase."

**Prevention**: When a prompt introduces naming conventions, include the convention in the Constraints section explicitly. Do not rely on the agent inferring conventions from the language.

### 4. Confirmation-pause hang

**Severity**: HIGH

**Expected state** (from prompt P2-S1): "Execute without asking for confirmation"

**Actual state**: Agent asked for confirmation before modifying `src/modules/users/routes.ts`. Execution engine treated the paused prompt as complete and advanced to the next prompt. The implementation was skipped, and prompt 3 failed because `routes.ts` did not exist.

**Root cause**: Agent applied interactive confirmation gates to headless prompt execution. The default confirmation rules from `agent-behavior.md` were not overridden by the prompt's execution authority constraint.

**Resolution**: Added "Execute without asking for confirmation" to Constraints in all implementation prompts per PRMT-EX-03. This overrides default confirmation gates for the duration of prompt file execution.

**Prevention**: Always include the execution authority constraint in implementation prompts. The constraint is the signal that the prompt carries implicit authority and the agent must complete without pausing.
`````

## Key Decisions

- **Unresolved vs Resolved sections**: Unresolved entries are scanned by later prompts at startup. Resolved entries stay for prevention notes but are not blockers (PRMT-RB-03).
- **Six-field entry format**: Every entry has severity, expected state, actual state, root cause, resolution, prevention. This ensures later prompts can scan titles and prevention notes without reading full entries (PRMT-RB-05).
- **Blocker deferred to PROBLEMS.md**: Entry 1 is unresolved and references `SETUPAPI-PR-0001` in PROBLEMS.md. The findings card captures the glitch detail; PROBLEMS.md records it as a problem to approach later (PRMT-RB-07).
- **Prevention notes propagate forward**: Entry 2's prevention note ("Never use `2>&1` with `Blocking: true`") was also added to `__CARD_01-Robustness.md`. Later prompts read the robustness card and avoid the pattern without reading the findings card entry.
- **Prompt step ID and line number in expected state**: Entry 2 references "prompt P2-S1, line 22" — this traces the glitch to the exact prompt and line that expected the behavior. Enables ex-post analysis without re-reading the full prompt sequence.
- **Card is a card, not a session file**: The findings card lives in the session folder as `__CARD_[TOPIC]-Findings.md`. It is loaded by every prompt that needs it. It is not PROBLEMS.md — PROBLEMS.md records deferred problems; the findings card captures ALL glitches including those fixed in-prompt.
