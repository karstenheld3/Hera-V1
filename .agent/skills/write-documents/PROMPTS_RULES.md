# Prompts File Rules

Rules for `_PROMPTS_[NN]-[Topic].md` files. Verifiable from the artifact alone.

**Writing quality:** Apply `APAPALAN_RULES.md` to all prompt content. Key rules: AP-PR-07 (be specific), AP-BR-02 (sacrifice grammar for brevity), AP-ST-01 (goal first), AP-NM-01 (one name per concept).

## Rule Index

Format (FT)
- PRMT-FT-01: First fence must appear before any non-commentary content (optional frontmatter per PRMT-FT-08)
- PRMT-FT-02: Fence length 3-9 backticks, outer exceeds deepest inner
- PRMT-FT-03: Separator `---` between every pair of consecutive prompts
- PRMT-FT-04: Commentary between prompts and before first prompt; notes MUST be in HTML comments; density limits apply
- PRMT-FT-05: At least one prompt per file
- PRMT-FT-06: No content outside fences intended for the model
- PRMT-FT-07: Heading consistency - headings recommended (SHOULD); if used, all prompts MUST have headings
- PRMT-FT-08: Optional execution frontmatter - YAML block at file start with execution hints
- PRMT-FT-09: prompt_system frontmatter empty when user requests workflow independence
- PRMT-FT-10: Prompt Marker inside fence in all sequences; with plan summary when using planning document

Structure (ST)
- PRMT-ST-01: Every prompt has an identifiable objective
- PRMT-ST-02: Implementation prompts include constraints
- PRMT-ST-03: Implementation prompts include verification criteria
- PRMT-ST-04: One reasoning mode per prompt
- PRMT-ST-05: Limit high-priority instructions to ~5-8 per prompt

Sequence (SQ)
- PRMT-SQ-01: No contradiction between prompts
- PRMT-SQ-02: Dependent prompts reference prior output explicitly
- PRMT-SQ-03: Commentary documents expected state between prompts
- PRMT-SQ-04: Interleaved verification prompts in sequences with 4+ implementation prompts

Content (CT)
- PRMT-CT-01: Objectives are specific and verifiable
- PRMT-CT-02: Constraints state what NOT to do
- PRMT-CT-03: Verification criteria are observable or machine-checkable
- PRMT-CT-04: No micromanaged implementation steps as objectives
- PRMT-CT-05: Precision over token savings (APAPALAN priority order)
- PRMT-CT-06: Signal redundancy preserved (MECT deliberate redundancy)
- PRMT-CT-07: Examples over descriptions for format and behavior
- PRMT-CT-08: Workflow execution on standalone lines without backticks (execution verb = execution required)
- PRMT-CT-09: Formatting discipline inside fences (no tables, no emojis, structure over decoration)
- PRMT-CT-10: Workflow references in backticks when not executing (no execution verb = reference only)
- PRMT-CT-11: Leverage existing workflows whenever possible
- PRMT-CT-12: Prefer agent tools over shell commands for file search and read operations
- PRMT-CT-13: Timestamp from request metadata, not extrapolated or estimated
- PRMT-CT-14: Banned-term sweep recording must not spell banned literals

Self-Contained (SC)
- PRMT-SC-01: Self-contained opening — context-loading directive, "treat earlier conversation as compacted", step identifier
- PRMT-SC-02: No conversation dependency — no "the previous step" or "as discussed above" without naming where output lives in a file
- PRMT-SC-03: Idempotency constraint — implementation prompts must include idempotency constraint
- PRMT-SC-04: Chain length limit — sequences under 6 steps; longer workflows split into sub-chains with checkpoints
- PRMT-SC-05: Effort and model specification — frontmatter must specify intended_model, context_window_size, effort level; prompts scoped to effort budget
- PRMT-SC-06: Planning document reference — prompt sequences from planning documents must reference the document by filename and step ID

Execution (EX)
- PRMT-EX-01: One prompt per turn - prompts are never concatenated into a single model submission
- PRMT-EX-02: Agent must not self-execute prompt files - writing a prompt file and running all prompts in one response circumvents the format
- PRMT-EX-03: Execution authority - prompts in _PROMPTS_*.md files carry implicit execution authority, agent must complete without asking for confirmation

Hang Safety (HS)
- PRMT-HS-01: Hang-safety clause required in implementation prompts
- PRMT-HS-02: Banned command list must be project-specific
- PRMT-HS-03: Time caps on all command executions
- PRMT-HS-04: On-cap behavior: kill, record, continue
- PRMT-HS-05: Process cleanup after command execution
- PRMT-HS-06: No interactive commands (stdin, pager, key wait, 2>&1 blocking)
- PRMT-HS-07: Verification names specific test files and residual sweeps
- PRMT-HS-08: Prior-step verification for dependent prompts
- PRMT-HS-09: Targeted test scope — specific test files during implementation, full suite only in final verification
- PRMT-HS-10: Spec-code consistency check in Verify when prompt changes code with associated spec

Robustness (RB)
- PRMT-RB-01: Findings card designated for the sequence
- PRMT-RB-02: Findings-card directive in every implementation prompt
- PRMT-RB-03: Findings card read at prompt startup for unresolved entries
- PRMT-RB-04: Glitches filed in findings card before end-of-prompt commit
- PRMT-RB-05: Glitch entry format: what, expected, actual, root cause, resolution, prevention
- PRMT-RB-06: Card system end-of-prompt protocol includes findings-card update step

Naming (NM)
- PRMT-NM-01: Filename follows `_PROMPTS_[NN]-[Topic].md` pattern
- PRMT-NM-02: Topic is CamelCase description of purpose
- PRMT-NM-03: [NN] is zero-padded sequence number starting at 01, enforcing execution order across multiple files

## PRMT-FT-01: Leading Fence Required

The first Opening Fence must appear before any non-Commentary content. Commentary (headings, notes) is allowed before the first prompt. Optional Execution Frontmatter (per PRMT-FT-08) may appear before Commentary. No other YAML frontmatter.

**BAD** (non-execution YAML frontmatter):
```markdown
---
title: Setup Prompts
---

`` `
Create a new Next.js project with TypeScript.
`` `
```

**GOOD** (optional execution frontmatter per PRMT-FT-08):
`````markdown
---
intended_model: claude-sonnet-4-5
context_window_size: 200k
effort: high
prompt_system: IPPS
---

## Prompt 1 - Create project

```
Create a new Next.js project with TypeScript.
```
`````

**GOOD** (commentary heading before first fence, no frontmatter):
`````markdown
## Prompt 1 - Create project

```
Create a new Next.js project with TypeScript.
```
`````

## PRMT-FT-02: Fence Length

Each prompt chooses its own fence length (3-9 backticks). The outer fence MUST be longer than the deepest inner fence within that prompt.

**BAD** (inner fence closes the outer fence):
``````markdown
```
Write a README containing:
```bash
npm install
```
```
``````

**GOOD** (outer fence longer than inner):
``````markdown
````
Write a README containing:
```bash
npm install
```
````
``````

## PRMT-FT-03: Separator Between Prompts

Every pair of consecutive prompts requires a `---` separator line between the closing fence and the next opening fence.

**BAD** (missing separator):
`````markdown
```
First prompt.
```

```
Second prompt.
```
`````

**GOOD:**
`````markdown
```
First prompt.
```

---

```
Second prompt.
```
`````

## PRMT-FT-04: Commentary Placement and Density

Commentary (headings, notes, explanations) is allowed between prompts and before the first prompt. Commentary is for human readers and is never sent to the model.

**Format rules:**
- Commentary headings (`## Prompt N - [title]`) are plain Markdown
- Commentary notes (explanations, expected state, context) MUST be wrapped in HTML comments (`<!-- ... -->`)
- Plain prose commentary between prompts is a violation - it must be in HTML comments

**Density rule:**
- **Final output files** (`_PROMPTS_[NN]-[Topic].md`): heading + max 1 sentence in one HTML comment per prompt
- **Template files** (`_PROMPTS_[Topic]_TEMPLATE.md`): no limit (authoring instructions need detail)

**BAD** (verbose prose commentary in final file, not in HTML comments):
`````markdown
---

## Prompt 2 - MEASURE baseline

Expected state: all findings classified, checks.yaml has tagged checks.
Code changes already implemented (recovery scenario).
Need to stash changes, capture baseline, restore, capture verify.

```
Run the eval test to capture baseline.
```
`````

**GOOD** (heading + 1 sentence in HTML comment in final file):
`````markdown
---

## Prompt 2 - MEASURE baseline

<!-- Expected state: findings classified, checks tagged, code changes implemented. -->

```
Run the eval test to capture baseline.
```
`````

**GOOD** (verbose commentary in template file, still in HTML comments):
`````markdown
---

<!-- MEASURE: Single baseline run for the entire batch.
All new checks should FAIL. This is the evidence baseline.
Expected state: one run folder with all checks recorded. -->

## Prompt 3 - MEASURE baseline (single run for batch)

```
**Objective**: MEASURE - Record the baseline eval score.
```
`````

## PRMT-FT-05: Minimum One Prompt

The file must contain at least one fenced prompt block. Empty files or files with only commentary are invalid.

## PRMT-FT-06: No Model-Intended Content Outside Fences

Any text outside fences is either commentary (never sent) or a format error. If content is intended for the model, it must be inside a fenced block.

**BAD** (instruction outside fence, silently dropped):
`````markdown
```
Create the database schema.
```

---

Also make sure to add indexes on the email column.

```
Write the migration script.
```
`````

**GOOD** (all model instructions inside fences):
`````markdown
```
Create the database schema. Add indexes on the email column.
```

---

```
Write the migration script for the schema created above.
```
`````

## PRMT-FT-07: Heading Consistency

Using Markdown headings before each prompt is recommended (SHOULD) but not required. However, if headings are used for any prompt's Commentary, all prompts in the file MUST have headings. Mixed files (some prompts with headings, some without) are invalid.

**Recommendation**: Use `## Prompt N - [short title]` or `## Step N - [short title]` before each prompt's Commentary section.

**GOOD** (headings on all prompts):
`````markdown
## Prompt 1 - Create project

```
Create a new Next.js project with TypeScript.
```

---

## Prompt 2 - Add authentication

```
Add JWT authentication to the Express API.
```
`````

**ACCEPTABLE** (no headings on any prompt):
`````markdown
```
Create a new Next.js project with TypeScript.
```

---

```
Add JWT authentication to the Express API.
```
`````

**AVOID** (inconsistent - heading on prompt 2 but not prompt 1, violates PRMT-FT-07):
`````markdown
```
Create a new Next.js project with TypeScript.
```

---

## Prompt 2 - Add authentication

```
Add JWT authentication to the Express API.
```
`````

This is a MUST rule for consistency: if any prompt has a heading, all must have headings. Using headings at all is a SHOULD recommendation.

## PRMT-ST-01: Identifiable Objective

Every prompt must contain a clear objective: what the finished state looks like. The reader (human or `/verify`) should be able to state in one sentence what the prompt asks for.

**BAD:**
`````markdown
```
Look at the auth code and maybe fix some things if needed, also check tests.
```
`````

**GOOD:**
`````markdown
```
Fix the validateToken middleware so expired JWTs return 401 instead of crashing the server.
```
`````

## PRMT-ST-02: Constraints for Implementation

Prompts that modify files, install packages, or change configuration must include constraints (what not to do).

**BAD** (no boundaries):
`````markdown
```
Add user authentication to the API.
```
`````

**GOOD:**
`````markdown
```
Add JWT authentication to the Express API.

Constraints:
- No new npm dependencies (use existing jsonwebtoken package)
- Do not modify the database schema
- Do not change the existing /health endpoint
```
`````

## PRMT-ST-03: Verification for Implementation

Prompts that produce testable output must include verification criteria.

**BAD:**
`````markdown
```
Fix the payment calculation bug.
```
`````

**GOOD:**
`````markdown
```
Fix the payment calculation bug where tax is applied twice on discounted items.

Verify: Run `pnpm test:payments`. All tests pass. Order total for a 100 EUR item with 10% discount and 19% tax equals 106.29 EUR.
```
`````

## PRMT-ST-04: One Reasoning Mode Per Prompt

Each prompt should perform one type of cognitive work. Mixing modes degrades quality because the model has no signal which role it is playing.

Reasoning modes: research, analysis, planning, implementation, testing, formatting, review.

**BAD** (research + implement + test in one prompt):
`````markdown
```
Research the best auth library for Express, implement it, and write tests.
```
`````

**GOOD** (split into focused prompts):
`````markdown
```
Research JWT authentication libraries for Express. Compare jsonwebtoken, jose, and passport-jwt. Recommend one with rationale.
```

---

## Step 2 - implement the recommended library

```
Using the recommended library from step 1, add JWT authentication to the Express API. Issue tokens on POST /login, validate on protected routes.
```

---

```
Write tests for the authentication endpoints. Cover: valid login, invalid credentials, expired token, missing token.
```
`````

## PRMT-ST-05: Instruction Density Limit

Practitioner heuristic: limit each prompt to ~5-8 high-priority rules or instructions. Beyond that, the model tends to skip items in the middle of long lists (lost-in-the-middle effect). The exact threshold varies by model and task.

**BAD** (12 constraints in one prompt):
`````markdown
```
Build the dashboard.
- Use React 18
- Use TypeScript strict mode
- Use Tailwind CSS
- Use shadcn/ui components
- Use React Query for data fetching
- Use Zod for validation
- Use React Hook Form for forms
- Support dark mode
- Support i18n
- Add error boundaries
- Add loading skeletons
- Add analytics tracking
```
`````

**GOOD** (split across setup + implementation prompts):
`````markdown
```
Create a React 18 dashboard with TypeScript strict mode, Tailwind CSS, and shadcn/ui. Set up the project skeleton with routing and layout.
```

---

## Step 2 - features and data layer

```
Add data fetching with React Query and form handling with React Hook Form + Zod validation. Implement the user list and edit form.

Constraints:
- Follow existing component patterns from step 1
- No additional UI libraries
```
`````

## PRMT-SQ-01: No Contradictions

Later prompts must not contradict constraints or decisions from earlier prompts in the same file.

**BAD:**
`````markdown
```
Set up the project with SQLite for the database. No external database services.
```

---

```
Connect the API to PostgreSQL for better query performance.
```
`````

**GOOD** (consistent throughout):
`````markdown
```
Set up the project with SQLite for the database. No external database services.
```

---

```
Optimize the SQLite queries for the user search endpoint. Add appropriate indexes.
```
`````

## PRMT-SQ-02: Explicit Dependency References

When a prompt depends on output from a prior prompt, name the dependency.

**BAD** (implicit dependency):
`````markdown
```
Write tests for all the functions.
```
`````

**GOOD** (names what was produced):
`````markdown
```
Write tests for the calc.py file created in step 1. Cover add(), subtract(), and multiply() with edge cases: zero, negative numbers, floating point.
```
`````

## PRMT-SQ-03: Commentary Documents State

Commentary sections between prompts should document expected state for human readers: what the previous prompt should have produced, what the next prompt expects. Commentary notes MUST be wrapped in HTML comments per PRMT-FT-04.

**BAD** (empty commentary, no context):
`````markdown
```
Create the config file.
```

---

```
Deploy the application.
```
`````

**GOOD** (heading + HTML comment with expected state):
`````markdown
```
Create config.yaml with database connection settings, API keys from environment variables, and logging configuration.
```

---

## Step 2 - deploy with the generated config

<!-- Previous step created config.yaml. The application should now be configurable via environment variables. -->

```
Deploy the application to the staging environment. Verify config.yaml is loaded and database connection succeeds.
```
`````

## PRMT-CT-01: Specific Objectives

Objectives must be specific enough that two readers would agree on whether the prompt was fulfilled.

**BAD:** "Improve the code", "Clean up the project", "Make it better"

**GOOD:** "Reduce the average API response time below 200ms for the /users endpoint", "Remove all unused imports from src/utils/"

## PRMT-CT-02: Negative Constraints

Constraints state boundaries in negative form: what the agent must NOT do.

**BAD:** "Use the existing libraries" (positive instruction, not a constraint)

**GOOD:** "Do not install new dependencies. Use only libraries already in package.json"

## PRMT-CT-03: Observable Verification

Verification criteria must be observable (you can see the result) or machine-checkable (a command produces pass/fail).

**BAD:** "Make sure it works correctly", "Code should be clean"

**GOOD:** "Run `pnpm test`. All tests pass", "Endpoint returns 200 with JSON body containing `{ status: 'ok' }`"

## PRMT-CT-04: Objectives Not Implementation Steps

**This rule takes precedence over PRMT-CT-05.** Precision tokens go into objectives, constraints, and verification criteria — never into implementation commands. Commands are acceptable only in `Verify:` sections (PRMT-CT-03). Commands in the prompt body = micromanagement.

The objective describes the desired outcome, not the steps to get there. The agent determines implementation.

**BAD:** "Open auth.ts, find line 42, change the timeout from 30 to 60"

**BAD:** Embedding `git stash push -m "..."` or `python evals/runner.py --scripted` in the objective. These are implementation steps the agent can derive from the objective.

**GOOD:** "The auth token expires too quickly for long-running API operations. Increase the token TTL to 60 seconds"

**GOOD:** "Capture a pre-change baseline by temporarily reverting uncommitted changes, run the eval, restore changes, then run the eval again. Derive attribution from check-level diff."

## PRMT-CT-05: Precision Over Token Savings

**Subordinate to PRMT-CT-04.** Precision applies to what (objectives), boundaries (constraints), and checks (verification) — not to how (implementation commands). Adding a `git stash` command is not precision; stating "capture a pre-change baseline" is.

APAPALAN's priority order applies to prompts: Precision (Priority 1) before Brevity (Priority 2). Never remove tokens that carry meaning to save context window space. One failed re-execution costs 10-50x more tokens than the precision tokens saved.

**BAD** (saves ~40 tokens by cutting precision):
`````markdown
```
Fix expired JWT handling in validateToken. No new deps. Run tests.
```
`````

**GOOD** (invests tokens in disambiguation):
`````markdown
```
Fix the validateToken middleware so expired JWTs return 401 instead of crashing the server.

Constraints:
- Do not modify the token generation logic in auth/issuer.ts
- Do not change the JWT secret rotation schedule

Verify: Run `pnpm test:auth`. All tests pass.
```
`````

The GOOD prompt costs ~35 more tokens. It succeeds on first execution. The BAD prompt omits the failure symptom (crash vs wrong status), scopes constraints too broadly ("no new deps" vs naming specific files to protect), and uses generic verification ("run tests" vs naming the test suite). Each omission is a guess the model must make - and may guess wrong.

**Token budget priority** (spend first on highest-impact items):
1. Constraints (prevent wrong actions - highest ROI per token)
2. Verification criteria (define done - prevents unbounded work)
3. Disambiguation (resolve ambiguous referents - prevents wrong targets)
4. Objective specificity (narrow scope - prevents over-engineering)
5. Examples (show format - replaces verbose descriptions)

## PRMT-CT-06: Signal Redundancy Preserved

MECT's deliberate redundancy principle: words that strengthen the model's association field are signal, not waste. Restating a referent, repeating a constraint qualifier, or naming a specific entity costs tokens but prevents the model from guessing wrong.

**BAD** (compressed - model may bind "it" to wrong referent):
`````markdown
```
Fix it. Also update the tests for it. Make sure it works with the new version.
```
`````

**GOOD** (referents restated - no ambiguity):
`````markdown
```
Fix the rate limiter in api/middleware.ts. Update the rate limiter tests in tests/middleware.test.ts. Verify the rate limiter works with Redis 7.x (the version deployed in staging).
```
`````

The GOOD prompt repeats "rate limiter" three times. Each repetition anchors the model to the correct target. Replacing any with "it" creates a potential misresolution that costs far more than 2 tokens per instance.

**Test**: "If I replace this noun with 'it' or 'this', could the model bind it to the wrong thing?" If yes, keep the explicit referent.

## PRMT-CT-07: Examples Over Descriptions for Format and Behavior

When a prompt must produce output in a specific format, show one example instead of describing the format in prose. AP-BR-05 (show format over describing format) applies directly. Examples are simultaneously more precise AND more token-efficient than descriptions.

**BAD** (describes format - 45 tokens, still ambiguous):
`````markdown
```
Generate a config file with database settings. It should have a top-level key for the database section, containing host, port, username, password, and database name fields, formatted as a YAML file with proper indentation.
```
`````

**GOOD** (shows format - 30 tokens, unambiguous):
``````markdown
````
Generate config.yaml with database connection settings.

Example output format:
```yaml
database:
  host: localhost
  port: 5432
  username: app_user
  password: ${DB_PASSWORD}
  name: myapp_production
```

Use environment variables for secrets.
````
``````

**Rules for examples in prompts:**
- One example per format. The model generalizes from one representative instance
- Place after objective and constraints, before verification
- Use realistic but generic values (privacy gate applies - no real credentials, addresses, or identifiers)
- If the codebase already contains the pattern, reference the file instead: "Follow the pattern in `src/api/users.py`"

## PRMT-CT-08: Workflow Execution on Standalone Lines Without Backticks

When a prompt requires the agent to EXECUTE a workflow, the slash command MUST appear on its own line without backticks. Any arguments or additional text go on the following line(s), never on the same line as the slash command. Execution means: the workflow file MUST be read, its steps MUST be followed, and its output MUST be produced. No exceptions.

**Decision procedure**: If the sentence containing the workflow name uses an execution verb (run, use, execute, call, invoke, perform, apply, do), the workflow is being EXECUTED. Move it to a standalone line without backticks. Backticks in prose with an execution verb = PRMT-CT-08 violation, regardless of article usage or parenthetical paths.

**BAD** (workflow execution buried in sentence with backticks):
`````markdown
```
After implementing the fix, make sure to run `/verify` against the spec and then `/commit`.
```
`````

**BAD** (execution verb with backticks — looks like reference but is execution):
`````markdown
```
Use the `/sync` workflow to sync PromptSystemV4.5/ to [AGENT_FOLDER]/.
```
`````

**BAD** (workflow buried in sentence without backticks):
`````markdown
```
After implementing the fix, make sure to run /verify against the spec and then /commit.
```
`````

**GOOD** (workflow execution on standalone lines, no backticks, arguments on next line):
`````markdown
```
After implementing the fix:

/verify
against specs/_SPEC_LANA_MVP-1.md

/commit
with conventional format
```
`````

**GOOD** (execution verb rewritten as standalone call):
`````markdown
```
Sync PromptSystemV4.5/ to [AGENT_FOLDER]/:

/sync
PromptSystemV4.5/ to [AGENT_FOLDER]/
```
`````

This aligns with `agent-behavior.md` "Prompt Templates in NOTES.md" which requires standalone lines for workflow calls in fenced prompt blocks.

## PRMT-CT-09: Formatting Discipline Inside Fences

Prompt content inside fences is consumed by LLMs, not rendered visually. Markdown rendering (bold, italic, tables) adds no signal for models. Use structural markers instead.

**Rules:**
- No Markdown tables inside fences - use lists or line-separated entries
- No emojis inside fences
- No bold/italic for emphasis within prose - models process tokens, not rendering
- Structural labels at line start are acceptable: `**Objective**:`, `**Step 1:**` - these function as parseable section markers, not visual decoration
- Use ALL CAPS for category labels (`REGRESSION`, `FIXED`, `NOT FIXED`) instead of bold
- Use line breaks and indentation for grouping, not horizontal rules

Source: `WORKFLOW_RULES.md` WF-CT-03 (no tables), WF-CT-04 (no emojis), GRUC "no visual-only formatting" principle.

**BAD** (visual formatting for emphasis):
`````markdown
````
Check the **critical** files in `src/auth/`. If any test **fails**, you **must** revert immediately.

| Finding | Status | Action |
|---------|--------|--------|
| PR-0001 | FIXED  | keep   |
| PR-0002 | FAIL   | revert |
````
`````

**GOOD** (structural markers only):
`````markdown
```
Check the critical files in src/auth/. If any test fails, revert immediately.

Finding status:
- PR-0001  FIXED   keep
- PR-0002  FAIL    revert
```
`````

## PRMT-CT-10: Workflow References in Backticks When Not Executing

When a prompt mentions a workflow as context — naming it, describing it, pointing to it — without requiring execution, the workflow name MUST be wrapped in backticks. Reference means: no execution requirement. The model may load the referenced workflow into context if it feels necessary, but is not required to execute it.

**Decision procedure**: If the sentence containing the workflow name has NO execution verb (run, use, execute, call, invoke, perform, apply, do), it is a reference. Wrap in backticks. If an execution verb IS present, it is execution (PRMT-CT-08), not reference — regardless of how the sentence is phrased.

**BAD** (workflow referenced in prose without backticks):
`````markdown
```
The /sync workflow handles file synchronization between source and target folders.
```
`````

**GOOD** (reference in backticks — no execution verb):
`````markdown
```
The `/sync` workflow handles file synchronization between source and target folders.
```
`````

**GOOD** (reference in backticks + execution on standalone line):
`````markdown
```
The `/sync` workflow handles file synchronization. To sync now:

/sync
PromptSystemV4.5/ to [AGENT_FOLDER]/
```
`````

Applies to all workflow names mentioned in prose: `/deep-research`, `/fact-check`, `/go`, `/verify`, `/write-prompts`, etc. When the workflow is being executed (PRMT-CT-08), it appears on its own line without backticks. Execution verb present = execution (PRMT-CT-08). No execution verb = reference (PRMT-CT-10).

## PRMT-CT-11: Leverage Existing Workflows Whenever Possible

Prompts MUST reference and use existing workflows from `[AGENT_FOLDER]/workflows/` whenever a matching workflow exists. This leverages standardized processes defined in the prompt system. Do not reinvent workflow logic in prompt prose when a workflow already handles the task.

**Before writing prompts**: Scan `[AGENT_FOLDER]/workflows/` frontmatters (the `description` field) to find applicable workflows. Load matching workflows entirely to understand their structure, steps, and dispatch patterns before designing prompts that build on or invoke them.

**When to reference a workflow**:
- A prompt instructs the agent to sync, verify, test, deploy, commit, or any action that has a dedicated workflow
- A prompt produces output that a downstream workflow consumes (e.g., prompt writes a SPEC, `/write-impl-plan` follows)
- A prompt's step overlaps with an existing workflow's scope

**When NOT to reference a workflow**:
- No matching workflow exists (e.g., domain-specific logic unique to the prompt sequence)
- User explicitly requests workflow independence (see PRMT-FT-09)
- The workflow's scope is tangential (mentioning it adds noise without actionable value)

**BAD** (reinvents sync logic in prompt prose):
`````markdown
```
Sync all changes from PromptSystemV4.5/ to [AGENT_FOLDER]/. Run sync.ps1 -diff first, review output, then run sync.ps1 -execute. Check that renamed files appear, new files exist, deprecated files deleted.
```
`````

**GOOD** (uses existing `/sync` workflow):
`````markdown
```
Use the `/sync` workflow (`[AGENT_FOLDER]/workflows/sync.md`) to sync all changes from PromptSystemV4.5/ to [AGENT_FOLDER]/. Follow the sync workflow's GLOBAL-RULES and Workspace Sync section.
```
`````

## PRMT-FT-08: Optional Execution Frontmatter

An optional YAML block at the very top of the file (before any Commentary or Opening Fence). Provides execution hints to the execution engine. The execution engine MAY honor these hints or override with its own configuration.

**Supported keys:**
- `intended_model`: Model identifier (e.g., `claude-sonnet-4-5`, `gpt-4o`)
- `context_window_size`: Context window size (e.g., `200k`, `128k`, `1M`)
- `effort`: Effort level (`low` | `medium` | `high` | `extra-high`)
- `prompt_system`: Prompt system identifier (e.g., `IPPS`)

**Rules:**
1. If present, frontmatter MUST be the first content in the file (no blank lines before opening `---`)
2. Only one frontmatter block allowed (at file start only)
3. Frontmatter is never sent to the model
4. Frontmatter is OPTIONAL - omit entirely if no execution hints needed
5. Unknown keys are ignored by the parser (forward compatibility)
6. If user explicitly requests prompt system independence, `prompt_system` MUST be empty or omitted. This signals that prompts do not depend on any specific workflow ecosystem.

**GOOD** (with frontmatter):
`````markdown
---
intended_model: claude-sonnet-4-5
context_window_size: 200k
effort: high
prompt_system: IPPS
---

## Prompt 1 - Analyze codebase

```
Analyze the authentication module for security vulnerabilities.
```
`````

**GOOD** (without frontmatter - still valid):
`````markdown
## Prompt 1 - Analyze codebase

```
Analyze the authentication module for security vulnerabilities.
```
`````

**BAD** (frontmatter not at file start - blank line before `---`):
`````markdown

---
intended_model: claude-sonnet-4-5
---

```
Analyze the authentication module.
```
`````

**BAD** (frontmatter after a prompt - this is a Separator, not frontmatter):
`````markdown
```
First prompt.
```

---

intended_model: claude-sonnet-4-5
---

```
Second prompt.
```
`````

## PRMT-FT-10: Prompt Marker

Every prompt in a prompt file MUST include a Prompt Marker as the first line inside each prompt's fence. The marker shows the current prompt number and total prompt count in zero-padded format: `Human Readable Prefix [ NN / NN ]`, followed by a summary of the prompt's purpose.

The summary matches the heading text. The marker format is: `Human Readable Prefix [ NN / NN ] - [brief summary]` where the prefix is a short human-readable label (max 4 words) describing the prompt sequence topic. When the prompt sequence is derived from a planning document (STRUT, TASKS, IMPL per PRMT-SC-06), the summary MUST include plan phase/step references: `Human Readable Prefix [ NN / NN ] - [plan step ID] [brief summary]`. Without a planning document, the summary is the heading text: `Human Readable Prefix [ NN / NN ] - [brief summary]`. The summary gives the model the same orientation the heading gives the human reader.

The marker goes inside the fence, as the first line of prompt content, followed by an empty line before the self-contained opening:

`````markdown
## Prompt 1 - Analyze requirements

```
Setup API Module [ 01 / 05 ] - Analyze requirements

Read `__CARD_00-Rules.md`...
```
`````

There is no minimum prompt count threshold. The marker is required for all sequences, including single-prompt files.

**Rules:**
1. Zero-padded to match the width of the total count (e.g., 5 prompts → 2 digits, 23 prompts → 2 digits, 100+ → 3 digits)
2. Total count is the number of prompts in the file, not the number of STRUT steps
3. If the file uses sub-chains with checkpoints (PRMT-SC-04), the total count is the number of prompts in the current sub-chain file
4. The marker appears inside the fence as first line of prompt content — the model sees it for progress tracking
5. The marker is updated when prompts are added or removed
6. The marker line MUST include a summary: `Human Readable Prefix [ NN / NN ] - [brief summary]`. The summary matches the heading text
7. When using a planning document (PRMT-SC-06), the summary MUST include plan phase/step references: `Human Readable Prefix [ NN / NN ] - [plan step ID] [brief summary]`
8. An empty line MUST follow the marker line, separating it from the prompt content (self-contained opening)
9. The marker prefix is a short human-readable label (max 4 words), not the literal word 'Prompt'. Derive from the task domain, planning document, or filename topic. Examples: `Setup API Module`, `Security Fix`, `Write Prompts Workflow`. When no clear topic is available, use a concise descriptive label.

**GOOD** (5-prompt sequence with markers and summary inside fence, no planning document):
`````markdown
## Prompt 1 - Analyze requirements

```
Setup API Module [ 01 / 05 ] - Analyze requirements

Read `__CARD_00-Rules.md`...
```

---

## Prompt 2 - Implement module

```
Setup API Module [ 02 / 05 ] - Implement module

Read `__CARD_00-Rules.md`...
```
`````

**GOOD** (5-prompt sequence with markers and plan summary inside fence):
`````markdown
## Prompt 1 - P4-S1 U10 stage A: untrusted-content delimiters in specs

```
Security Fix [ 01 / 05 ] - P4-S1 U10 stage A: untrusted-content delimiters in specs

Read `__CARD_00-Rules.md`...
```

---

## Prompt 2 - P4-S2 U10 stage B-C: renderToolResult, wrapped tools, commit

```
Security Fix [ 02 / 05 ] - P4-S2 U10 stage B-C: renderToolResult, wrapped tools, commit

Read `__CARD_00-Rules.md`...
```
`````

**BAD** (5-prompt sequence with plan, marker without summary):
`````markdown
## Prompt 1 - P4-S1 U10 stage A: untrusted-content delimiters in specs

```
Security Fix [ 01 / 05 ]

Read `__CARD_00-Rules.md`...
```
`````

**BAD** (5-prompt sequence without plan, marker without summary):
`````markdown
## Prompt 1 - Analyze requirements

```
Setup API Module [ 01 / 05 ]

Read `__CARD_00-Rules.md`...
```
`````

**BAD** (5-prompt sequence without markers):
`````markdown
## Prompt 1 - Analyze requirements

```
Read `__CARD_00-Rules.md`...
```
`````

**BAD** (marker in heading instead of inside fence):
`````markdown
## Setup API Module [ 01 / 05 ] - Analyze requirements

```
Read `__CARD_00-Rules.md`...
```
`````

## PRMT-EX-01: One Prompt Per Turn

Each Prompt Block in a prompt file is a separate turn: submitted individually to the model, with the model response received before the next prompt is submitted. Concatenating all prompts into a single model submission is a format violation.

Prompt files exist to work around the context, compute, and output limits of a single model run. Each turn receives the agent's full context engineering and input rendering. Concatenation collapses the sequence into one run, limiting execution depth to whatever the model can produce in a single response.

**BAD** (agent concatenates all prompts into one submission):
````markdown
```
Do step 1: analyze the code. Then do step 2: fix the bug. Then do step 3: run tests.
```
````

**GOOD** (each prompt is a separate turn, executed sequentially):
````markdown
```
Analyze the authentication module for security vulnerabilities.
```

---

```
Fix the highest-severity vulnerability found in the previous step.
```

---

```
Run the test suite. All tests must pass.
```
````

## PRMT-EX-02: Agent Must Not Self-Execute Prompt Files

An agent that writes a prompt file and then immediately executes all prompts in a single run is NOT executing the prompt file - it is circumventing the format. The agent's internal context engineering, input rendering, and compute allocation mechanisms apply to each turn individually. Self-executing all prompts at once collapses them into a single turn, defeating the purpose of decomposing work into a prompt queue.

Prompt files are authored for an execution engine (e.g., Lana) that submits prompts one at a time. The writing agent creates the file; the execution engine runs it. These are separate roles.

**BAD** (agent writes prompt file, then runs all prompts in one response):
- Agent creates `_PROMPTS_01-FixAuth.md` with 3 prompts
- Agent immediately processes all 3 prompts in a single response, as if they were one instruction
- Result: single-run depth limit, no per-turn context engineering

**GOOD** (agent writes prompt file for later execution):
- Agent creates `_PROMPTS_01-FixAuth.md` with 3 prompts
- Agent delivers the file to the user or execution engine
- Execution engine (Lana, headless runner, or human submitting one prompt at a time) processes each prompt as a separate turn

## PRMT-EX-03: Execution Authority

Prompts in `_PROMPTS_*.md` files carry implicit execution authority. The agent must complete the prompt's objective without pausing to ask the user for confirmation. Confirmation pauses hang the sequence: the execution engine treats the paused prompt as complete and advances to the next prompt, skipping work and corrupting state.

This rule overrides default confirmation gates (e.g., `agent-behavior.md` confirmation rules) for the duration of prompt file execution. The prompt's Constraints section defines boundaries — what NOT to do. Within those boundaries, the agent executes without asking.

Verifiable from artifact: check that implementation prompts include "Execute without asking for confirmation" or equivalent in Constraints.

**BAD** (no execution authority constraint):
`````markdown
```
Read `src/auth/validator.ts`. Treat earlier conversation as compacted. Step P2-S3.

Fix the token validation bug where expired tokens crash the server.

Constraints:
- Do not modify the token generation logic
- Re-running this prompt must not corrupt state or waste cost
```
`````

**GOOD** (execution authority constraint present):
`````markdown
```
Read `src/auth/validator.ts`. Treat earlier conversation as compacted. Step P2-S3.

Fix the token validation bug where expired tokens crash the server.

Constraints:
- Do not modify the token generation logic
- Execute without asking for confirmation
- Re-running this prompt must not corrupt state or waste cost
```
`````

## PRMT-NM-01: Filename Pattern

`_PROMPTS_[NN]-[Topic].md` where [NN] is a zero-padded sequence number and Topic is CamelCase.

**BAD:** `prompts.md`, `PROMPTS-setup.md`, `_PROMPTS_setup project.md`, `_PROMPTS_SetupProject.md`

**GOOD:** `_PROMPTS_01-SetupProject.md`, `_PROMPTS_02-MigrateAuth.md`, `_PROMPTS_01-AnalyzePerformance.md`

## PRMT-NM-02: Topic Describes Purpose

The Topic in the filename describes the prompts file purpose, not the project or session.

**BAD:** `_PROMPTS_01-MyProject.md`, `_PROMPTS_01-Session3.md`

**GOOD:** `_PROMPTS_01-SetupCICD.md`, `_PROMPTS_02-RefactorAuthModule.md`

## PRMT-NM-03: Sequence Number Enforces Execution Order

[NN] is a zero-padded 2-digit sequence number starting at `01`. When multiple prompt files exist in the same folder, the number enforces execution order. Single-file sequences still require the number (`01`).

**BAD:** `_PROMPTS_SetupProject.md` (no number), `_PROMPTS_1-SetupProject.md` (not zero-padded)

**GOOD:** `_PROMPTS_01-SetupProject.md`, `_PROMPTS_02-MigrateAuth.md`

When a chain is split into sub-chains (PRMT-SC-04), each sub-chain file gets its own number in the same sequence: `_PROMPTS_01-ImplCore.md`, `_PROMPTS_02-ImplAuth.md`, `_PROMPTS_03-Verify.md`.

## PRMT-SC-01: Self-Contained Opening

Every prompt in a sequence must begin with a self-contained opening that enables execution after context reset. The opening contains three elements:

1. A context-loading directive naming the files or cards to read before doing anything else
2. An explicit statement that earlier conversation is not in context: "Treat earlier conversation as compacted"
3. A step identifier (STRUT step, task ID, or sequence position) for progress tracking

All three elements must appear at the start of the prompt, before the objective. A prompt that omits any element breaks on context reset: without the directive, the model does not know what to read; without the compacted statement, the model may assume prior context; without the step identifier, progress tracking fails.

**BAD** (assumes prior context, no opening):
`````markdown
```
Using the analysis from the previous step, fix the authentication bug in the token validator.
```
`````

**GOOD** (self-contained opening with all three elements):
`````markdown
```
Read `__CARD_00-Rules.md` and `src/auth/validator.ts` lines 45-80. Treat earlier conversation as compacted. Step P2-S3.

Fix the token validation bug where expired tokens crash the server instead of returning 401.
```
`````

**BAD** (has directive but no compacted statement, no step ID):
`````markdown
```
Read `src/auth/validator.ts`. Fix the token validation bug where expired tokens crash the server.
```
`````

## PRMT-SC-02: No Conversation Dependency

No prompt may reference "the previous step", "as discussed above", "the earlier analysis", or any prior conversation content without naming where that content lives in a file. Prompts must reconstruct state from files, not from model memory of prior prompts.

Verifiable from artifact: scan each prompt for conversation-reference phrases ("previous step", "as discussed", "earlier", "above", "the analysis from"). If found, check whether the prompt also names a file path where the referenced content lives. If no file path accompanies the reference, the prompt violates this rule.

**BAD** (conversation reference without file location):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P3-S1.

Using the findings from the previous step, implement the database schema.
```
`````

**GOOD** (references prior output by file path):
`````markdown
```
Read `__CARD_00-Rules.md` and `_INFO_DatabaseDesign.md` section 2. Treat earlier conversation as compacted. Step P3-S1.

Implement the database schema defined in `_INFO_DatabaseDesign.md` section 2. Create the migration file `migrations/001_init_schema.sql`.
```
`````

## PRMT-SC-03: Idempotency Constraint

Implementation prompts (prompts that modify files, install packages, or change configuration) must include an idempotency constraint in the Constraints section. The constraint states that re-running the prompt must not corrupt state, duplicate work, or waste cost.

The idempotency constraint is a negative constraint (PRMT-CT-02) that prevents a specific failure class: partial execution followed by re-run producing inconsistent state.

Verifiable from artifact: check the Constraints section of each implementation prompt for an idempotency statement. Research or analysis prompts (no file modifications) are exempt.

**BAD** (implementation prompt without idempotency constraint):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Create the user model in `src/models/user.ts` with fields: id, email, name, created_at.

Constraints:
- Do not modify the existing database connection file
- Use TypeScript strict mode
```
`````

**GOOD** (idempotency constraint present):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Create the user model in `src/models/user.ts` with fields: id, email, name, created_at.

Constraints:
- Do not modify the existing database connection file
- Use TypeScript strict mode
- Re-running this prompt must not corrupt state or waste cost: if `src/models/user.ts` already exists and passes validation, skip creation
```
`````

## PRMT-SC-04: Chain Length Limit

Prompt sequences must stay under 6 steps. For longer workflows, split into sub-chains with checkpoints between them. Each sub-chain completes, commits, and the next sub-chain starts fresh with its own self-contained opening.

Error rates compound across steps. A 5% per-step error rate yields 14% end-to-end failure at 3 steps, 26% at 6 steps, 40% at 10 steps. Keeping sequences under 6 steps limits the blast radius of a single step failure.

Verifiable from artifact: count the number of prompts (fenced blocks separated by `---`) in the file. If the count exceeds 6, check whether the file is explicitly documented as a sub-chain with a checkpoint reference to the next sub-chain.

**BAD** (10-prompt sequence with no sub-chain structure):
`````markdown
## Prompt 1 - Analyze
```
...
```
---
## Prompt 2 - Design
```
...
```
---
## Prompt 3 - Setup
```
...
```
---
## Prompt 4 - Implement model
```
...
```
---
## Prompt 5 - Implement API
```
...
```
---
## Prompt 6 - Implement UI
```
...
```
---
## Prompt 7 - Write tests
```
...
```
---
## Prompt 8 - Integration test
```
...
```
---
## Prompt 9 - Deploy
```
...
```
---
## Prompt 10 - Verify deployment
```
...
```
`````

**GOOD** (sub-chain with checkpoint, under 6 steps):
`````markdown
<!-- Sub-chain 1 of 2: Setup and implementation. Checkpoint after Prompt 4 commits. Sub-chain 2 starts fresh. -->

## Prompt 1 - Analyze requirements
```
...
```
---
## Prompt 2 - Design schema
```
...
```
---
## Prompt 3 - Implement model
```
...
```
---
## Prompt 4 - Implement API and commit checkpoint
```
...
```
`````

## PRMT-SC-05: Effort and Model Specification

Prompt file frontmatter must specify `intended_model`, `context_window_size`, and `effort` level. The effort level determines the practical scope of each prompt: at low effort, each prompt must be tightly scoped (one file, one edit); at high effort, a single prompt can handle multi-file analysis and implementation.

The prompt count must match the effort budget. A task that requires 8 prompts at low effort may require 2 prompts at high effort. Mismatched effort and prompt count produces either overloaded prompts (low effort, too many steps) or underutilized prompts (high effort, unnecessary fragmentation).

Verifiable from artifact: check frontmatter for `intended_model`, `context_window_size`, and `effort` keys. Check that prompt count is consistent with the effort level (low effort = more prompts, high effort = fewer prompts).

**BAD** (no effort specification, prompt count mismatch):
`````markdown
---
intended_model: claude-sonnet-4-5
context_window_size: 200k
prompt_system: IPPS
---

## Prompt 1 - Do everything
```
Analyze the codebase, design the schema, implement all models, write all tests, and deploy.
```
`````

**GOOD** (effort specified, prompt count matches):
`````markdown
---
intended_model: claude-sonnet-4-5
context_window_size: 200k
effort: high
prompt_system: IPPS
---

## Prompt 1 - Analyze and design
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P1-S1.

Analyze the codebase and design the database schema. Write the schema design to `_INFO_SchemaDesign.md`.
```
`````

## PRMT-SC-06: Planning Document Reference

Prompt sequences generated from planning documents (TASKS, STRUT, IMPL) must reference the planning document by filename and step ID. The reference appears in the self-contained opening (PRMT-SC-01) as part of the step identifier.

The planning document is the source of truth for sequence state. Without an explicit reference, the agent cannot determine progress, maintain state, or detect drift on resume.

Verifiable from artifact: check each prompt's opening for a planning document filename and step ID. Sequences not generated from a planning document (ad-hoc sequences) are exempt but should reference their own file as the tracking document.

**BAD** (no planning document reference):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted.

Implement the user authentication module with JWT tokens.
```
`````

**GOOD** (planning document referenced by filename and step):
`````markdown
```
Read `__CARD_00-Rules.md` and `__STRUT_AuthImplementation.md` step P2-S3. Treat earlier conversation as compacted. Step P2-S3.

Implement the user authentication module with JWT tokens as specified in `__STRUT_AuthImplementation.md` step P2-S3.
```
`````

## PRMT-HS-01: Hang-Safety Clause Required

Implementation prompts (prompts that run commands, execute builds, run tests, or spawn processes) MUST include a hang-safety clause in the Constraints section. The clause states that no command may wait for a key, stdin, a pager, or an unbounded child. One hung command stops the entire prompt sequence — the execution engine cannot skip it.

Research or analysis prompts that only read files are exempt. Prompts that run any command beyond file reads must include the clause.

See `PROMPTS_ROBUSTNESS_GUIDES.md` for the clause template, project-specific banned lists, safe command patterns, and inter-prompt problem filing.

Verifiable from artifact: check the Constraints section of each implementation prompt for a hang-safety statement. Prompts without any command execution are exempt.

**BAD** (implementation prompt without hang-safety clause):
`````markdown
```
Run the test suite and verify all tests pass.

Constraints:
- Do not modify test files
- Re-running this prompt must not corrupt state or waste cost
```
`````

**GOOD** (hang-safety clause present):
`````markdown
```
Run the test suite and verify all tests pass.

Constraints:
- Do not modify test files
- Re-running this prompt must not corrupt state or waste cost
- Hang safety: no command may wait for stdin, a pager, or an unbounded child. Banned: git log without --no-pager. Test suites run with a 10-minute cap. On cap: kill, record in PROBLEMS.md, continue.
```
`````

## PRMT-HS-02: Banned Command List Must Be Project-Specific

The hang-safety clause must list project-specific commands known to hang. Generic hang risks (stdin, pager, unbounded children) apply to all projects, but the specific commands that trigger them vary by project. The banned list is built by scanning the project for scripts containing `pause`, `Read-Host`, `ReadKey`, CLI tools reading stdin without arguments, and `--watch` flags.

Verifiable from artifact: check that the hang-safety clause names at least one project-specific banned command or explicitly states "no project-specific hang risks identified."

**BAD** (generic only, no project-specific entries):
`````markdown
Hang safety: no command may wait for stdin or a pager.
```
`````

**GOOD** (project-specific banned commands listed):
`````markdown
Hang safety: no command may wait for a key, stdin, a pager, or an unbounded child. Banned: build.bat (contains pause), app.exe without -p (interactive console), 2>&1 with Blocking:true (pipe deadlock). Test suites run with a 10-minute cap. On cap: kill, record in PROBLEMS.md, continue.
```
`````

## PRMT-HS-03: Time Caps on All Command Executions

Every command that runs a process (test suites, builds, application runs, long-running scripts) must specify a time cap in the hang-safety clause or verification section. The cap prevents indefinite waits when a process hangs. Caps depend on command type: single test files (3 min), full suites (10 min), builds (15 min), application runs (3 min).

Verifiable from artifact: check that each command-execution prompt specifies a time cap for long-running commands. Prompts that only run instant commands (git status, file reads) are exempt.

**BAD** (no time cap on test suite execution):
`````markdown
Verify: Run `bun test`. All tests pass.
```
`````

**GOOD** (time cap specified):
`````markdown
Verify: Run `bun test --timeout 20000` non-blocking with a 10-minute cap. All tests pass. On cap: kill, record in PROBLEMS.md, continue.
```
`````

## PRMT-HS-04: On-Cap Behavior

The hang-safety clause must specify what happens when a command exceeds its time cap: (1) kill the process tree, (2) record the command and cap in PROBLEMS.md, (3) continue with the next step. Never re-run the same command blocking after a cap.

Verifiable from artifact: check that the hang-safety clause or verification section includes on-cap behavior: kill, record, continue.

**BAD** (no on-cap behavior):
`````markdown
Hang safety: no command may wait for stdin. Test suites run with a 10-minute cap.
```
`````

**GOOD** (on-cap behavior specified):
`````markdown
Hang safety: no command may wait for stdin. Test suites run with a 10-minute cap. On cap: stop the process tree, record command and cap in PROBLEMS.md, continue with the next step. Never re-run the same command blocking.
```
`````

## PRMT-HS-05: Process Cleanup After Command Execution

Prompts that spawn processes (test runners, builds, application runs) must specify process cleanup after execution. The clause must verify no orphan processes remain and stop them if found. This prevents orphaned processes from accumulating across prompts and consuming resources.

Verifiable from artifact: check that prompts spawning processes include a cleanup statement: verify no orphans, stop if found.

**BAD** (no cleanup after process-spawning command):
`````markdown
Verify: Run `bun test`. All tests pass.
```
`````

**GOOD** (cleanup specified):
`````markdown
Verify: Run `bun test --timeout 20000` non-blocking with a 10-minute cap. After completion: `Get-Process [name]* -ErrorAction SilentlyContinue` returns nothing. Orphans stopped, count recorded in PROGRESS.md.
```
`````

## PRMT-HS-06: No Interactive Commands

No prompt may contain commands that wait for interactive input. This includes: stdin reads (`Read-Host`, `pause`, `Get-Credential`, `read`, `select`), pagers (`git log` without `--no-pager`, `less`, `more`), unbounded children (`--watch` flags, `Start-Process` of GUI applications), and `2>&1` with blocking execution (PowerShell pipe deadlock).

Verifiable from artifact: scan each prompt for interactive command patterns. If found, check whether the prompt also specifies a non-interactive alternative or explicitly bans the interactive form.

**BAD** (bare git log, launches pager):
`````markdown
Verify: Run `git log` to confirm the commit history.
```
`````

**GOOD** (non-interactive git command):
`````markdown
Verify: Run `git --no-pager log -n 20` to confirm the commit history.
```
`````

## PRMT-HS-07: Verification Names Specific Tests and Sweeps

When a prompt changes code that has associated tests, the Verify section must name the specific test file(s) affected, not just "run tests." When a prompt removes concepts (old protocol, old naming), the Verify section must include a residual sweep command. When a prompt depends on prior steps, the Verify section must confirm the prior step is done.

This prevents three glitches observed in the Lana-V2-Dev session: (1) test regressions surviving multiple prompts because "bun test green" did not name the affected test file, (2) removed concepts silently persisting, (3) implementation proceeding without spec prerequisites.

Verifiable from artifact: check that verification sections name specific test files when code changes affect tests, include residual sweeps when concepts are removed, and confirm prior steps when dependencies exist.

**BAD** (generic verification, no specific test file):
`````markdown
Verify: bun test green, bun tsc --noEmit green.
```
`````

**GOOD** (specific test file named, residual sweep included):
`````markdown
Verify: Run `bun test tests/unit/prompt_assemble.test.ts`. All tests pass. `bun tsc --noEmit` — no type errors. `Select-String -Pattern 'guard_request' -Path src/` returns zero matches. STRUT step P3-S4 is `[x]` in `__STRUT_LANAV2HRNS.md`.
```
`````

## PRMT-HS-08: Prior-Step Verification for Dependent Prompts

When a prompt depends on a prior step (spec amendment before implementation, fixture creation before equivalence test), the prompt must verify the prior step is done before proceeding. This prevents STRUT sequencing violations where implementation runs without spec backing.

Verifiable from artifact: check that dependent prompts include a prior-step verification in the opening or verify section: "Confirm STRUT step [ID] is `[x]` in [filename]."

**BAD** (no prior-step check):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P3-S5.

Implement the gate socket for all 15 tools.
```
`````

**GOOD** (prior-step verification):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P3-S5.

Confirm in PROGRESS.md that STRUT step P3-S4 is `[x]`. Stop if it is not.

Implement the gate socket for all 15 tools.
```
`````

## PRMT-RB-01: Findings Card Designated

Every prompt sequence that risks encountering problems MUST designate a findings card — a card file loaded and updated by every prompt that needs it. The card records glitches, spec-code mismatches, and unexpected findings between prompts. The card is created once and appended to by every implementation prompt in the sequence. No prompt creates a new findings card; all append to the same one.

Session PROBLEMS.md records problems encountered during prompt execution that must be approached later (blockers, deferred issues). The findings card captures ALL glitches including those fixed in-prompt, not just blockers. See PRMT-RB-07 for the PROBLEMS.md distinction.

Verifiable from artifact: check that the prompt sequence names a `__CARD_[TOPIC]-Findings.md` card in at least one prompt or in the session setup.

**BAD** (no findings card designated):
`````markdown
```
Implement the authentication module. Run tests.
```
`````

**GOOD** (findings card designated):
`````markdown
```
Implement the authentication module. Run tests.

Findings card: Load and update `__CARD_[TOPIC]-Findings.md`. File glitches, spec-code mismatches, and unexpected findings. Read at prompt startup for unresolved entries from prior prompts.
```
`````

## PRMT-RB-02: Findings-Card Directive in Every Implementation Prompt

Every implementation prompt MUST include a `Findings card:` directive pointing to the shared findings card. The directive goes after the hang-safety clause and before the closing protocol. Research prompts that run no commands are exempt but should include the directive if they might encounter unexpected findings.

Verifiable from artifact: check that each implementation prompt contains a `Findings card:` line referencing the shared card.

## PRMT-RB-03: Findings Card Read at Prompt Startup

Each prompt loads the findings card at startup, after reading session cards and before starting work. The agent scans for unresolved entries from prior prompts that affect the current prompt's scope. Full entries are read only when a title matches the current prompt's work.

Verifiable from artifact: check that the prompt's self-contained opening includes a directive to load the findings card, or that the card system start-of-prompt protocol includes a findings-card read step.

## PRMT-RB-04: Glitches Filed in Findings Card Before End-of-Prompt Commit

Glitches and findings are filed in the findings card before the end-of-prompt commit. The agent records what happened, why, and how to prevent it. Filing happens after verification and before the STRUT step is marked done.

Verifiable from artifact: check that the card system end-of-prompt protocol or the prompt body includes a findings-card update step before the commit step.

## PRMT-RB-05: Glitch Entry Format

Each glitch entry in the findings card MUST record: title, severity (HIGH/MEDIUM/LOW), expected state (with prompt step ID and line), actual state, root cause, resolution (or PROBLEMS.md reference), and prevention note. Entries without all six fields are incomplete.

Verifiable from artifact: check that entries in the findings card follow the six-field format.

## PRMT-RB-06: Card System End-of-Prompt Protocol Includes Findings-Card Update

When a prompt sequence uses a card system, the end-of-prompt protocol (card 00 Section 4) MUST include a findings-card update step: file glitches and findings in the findings card before marking the STRUT step done and committing. The start-of-prompt protocol (card 00 Section 3) MUST include a findings-card read step for unresolved entries from prior prompts.

Verifiable from artifact: check that card 00 Section 3 includes a findings-card read step and Section 4 includes a findings-card update step.

**BAD** (card 00 Section 4 without findings-card update):
`````markdown
## 4. End-of-prompt protocol
1. Verification named in the prompt passed
2. Mark the STRUT step [ ] -> [x]
3. Append one line to session PROGRESS.md
4. Record blockers in session PROBLEMS.md
5. Commit both repos where changed
```
`````

**GOOD** (card 00 Section 4 with findings-card update):
`````markdown
## 4. End-of-prompt protocol
1. Verification named in the prompt passed
2. File glitches and findings in __CARD_[TOPIC]-Findings.md
3. Mark the STRUT step [ ] -> [x]
4. Append one line to session PROGRESS.md
5. Record blockers in session PROBLEMS.md
6. Commit both repos where changed
```
`````

## PRMT-RB-07: Session PROBLEMS.md Records Deferred Problems

Session PROBLEMS.md records problems encountered during prompt execution that must be approached later. This includes: blockers that stopped a prompt from completing, deferred issues that could not be fixed in-prompt, and timeouts or hangs that require investigation. PROBLEMS.md does NOT replace the findings card — it records problems that need later attention, while the findings card captures ALL glitches including those fixed in-prompt.

Verifiable from artifact: check that PROBLEMS.md entries describe problems requiring later attention, not detailed glitch logs. Glitch details belong in the findings card.

## PRMT-SQ-04: Interleaved Verification Prompts

Sequences with 4 or more implementation prompts must include interleaved verification prompts every 2-3 implementation prompts. A verification prompt runs `/verify` against the planning document (STRUT or TASKS) and the prompts file for prompts executed so far, then runs `/fix` to address gaps and remaining work. This catches drift early — before downstream prompts build on incorrect state.

Rationale: A Lana-V2-Dev SecurityRemediation sequence had 5 sub-chains with 3-5 prompts each. Without interleaved verification, spec-code mismatches accumulated across prompts and were only caught at the end, requiring expensive rework. Interleaved verification prompts inserted after every 2 implementation prompts would have caught drift at the point of occurrence, limiting blast radius to 2 prompts instead of the full sequence.

Verification prompts are NOT implementation prompts — they do not run code, tests, or builds. They run `/verify` and `/fix` workflows only. They do not count toward the chain length limit (PRMT-SC-04).

Verifiable from artifact: check that sequences with 4+ implementation prompts contain at least one verification prompt (containing `/verify` and `/fix` workflow calls) between implementation prompts, not only at the end.

**BAD** (5 implementation prompts, no interleaved verification):
`````markdown
## Prompt 1 - Setup
```
[implementation prompt]
```
---
## Prompt 2 - Implement Auth
```
[implementation prompt]
```
---
## Prompt 3 - Implement Token Validation
```
[implementation prompt]
```
---
## Prompt 4 - Implement Rate Limiting
```
[implementation prompt]
```
---
## Prompt 5 - Finalize
```
[implementation prompt]
```
`````

**GOOD** (5 implementation prompts with interleaved verification after prompt 2 and prompt 4):
`````markdown
## Prompt 1 - Setup
```
[implementation prompt]
```
---
## Prompt 2 - Implement Auth
```
[implementation prompt]
```
---
## Verification Checkpoint 1

<!-- Verify prompts 1-2 against STRUT before continuing. -->

```
Read `__CARD_00-Rules.md` and `__STRUT_[Topic].md`. Treat earlier conversation as compacted. Verification checkpoint after prompts 1-2.

/verify

current state against `__STRUT_[Topic].md` for prompts executed so far.

/fix

all gaps and remaining work.
```
---
## Prompt 3 - Implement Token Validation
```
[implementation prompt]
```
---
## Prompt 4 - Implement Rate Limiting
```
[implementation prompt]
```
---
## Verification Checkpoint 2

<!-- Verify prompts 1-4 against STRUT before final prompt. -->

```
Read `__CARD_00-Rules.md` and `__STRUT_[Topic].md`. Treat earlier conversation as compacted. Verification checkpoint after prompts 3-4.

/verify

current state against `__STRUT_[Topic].md` for prompts executed so far.

/fix

all gaps and remaining work.
```
---
## Prompt 5 - Finalize
```
[implementation prompt]
```
`````

## PRMT-CT-12: Prefer Agent Tools Over Shell Commands for File Operations

Prompts must direct the agent to use built-in tools (grep_search, read_file, find_by_name, code_search) for file search, read, and list operations. Shell commands (Select-String, Get-ChildItem -Recurse, Get-Content, cat, grep, find, rg.exe) must not appear in prompt bodies for file exploration or reading. Shell commands are for process execution only: builds, tests, git operations, and explicit residual sweeps in verification sections.

Rationale: Agent built-in tools are faster, non-hanging, and respect workspace permissions. Shell commands for file operations risk hangs (Get-Content -Wait, Get-ChildItem -Recurse on large trees, pipe deadlocks) and bypass the agent's file access layer. A Lana-V2-Dev session documented shell commands causing 2>&1 pipe deadlocks with Blocking: true, and Get-ChildItem -Recurse hanging on large trees. Another session documented grep_search tool failures (tool bug, not prompt-related), but prompts embedding shell commands as default approach prevents the agent from leveraging its tools when they work correctly.

Verifiable from artifact: scan prompt bodies (excluding Verify sections) for shell file-operation commands (Select-String, Get-ChildItem, Get-Content, cat, grep, find, rg). If found outside Verify sections, the prompt violates this rule. Verify sections may use shell commands for residual sweeps and explicit command-based checks.

**BAD** (prompt body uses shell command for file search):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Search for all references to `validateToken` in src/ using `Select-String -Pattern 'validateToken' -Path src/ -Recurse`.
```
`````

**GOOD** (prompt body uses agent tool directive):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Search for all references to `validateToken` in src/ using the grep_search tool.
```
`````

**GOOD** (Verify section uses shell command for residual sweep — acceptable):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Remove all references to `guard_request` from src/.

Verify: `Select-String -Pattern 'guard_request' -Path src/` returns zero matches.
```
`````

## PRMT-HS-09: Targeted Test Scope

Verification sections must run specific test files, not the full test suite, during implementation steps. Full test suite runs are reserved for final verification steps only. Running the full suite during implementation risks hangs from long-running integration tests, flaky timing-dependent tests, and process accumulation.

This rule strengthens PRMT-HS-07 (which requires naming specific test files) by also requiring that only those files are executed, not the full suite. A Lana-V2-Dev session documented the full `bun test` suite hanging indefinitely, while targeted test files completed in seconds. Another session documented a flaky test that failed in the full suite but passed in isolation due to timing pressure from other tests in the same run.

Verifiable from artifact: check that verification sections in implementation prompts run specific test files (e.g., `bun test tests/unit/auth.test.ts`), not bare `bun test` or `npm test` (full suite). Final verification steps may run the full suite if explicitly marked as such.

**BAD** (full suite during implementation):
`````markdown
```
Fix the token validation bug where expired tokens crash the server.

Verify: Run `bun test`. All tests pass.
```
`````

**GOOD** (targeted test files during implementation):
`````markdown
```
Fix the token validation bug where expired tokens crash the server.

Verify: Run `bun test tests/unit/auth.test.ts tests/unit/token_validator.test.ts`. All tests pass.
```
`````

**GOOD** (full suite in final verification — acceptable when explicitly marked):
`````markdown
```
Final verification: run the full test suite to confirm no regressions.

Verify: Run `bun test --timeout 20000` non-blocking with a 10-minute cap. All tests pass.
```
`````

## PRMT-CT-13: Timestamp from Request Metadata

Document History timestamps must match the wall clock from the current prompt's request metadata, not extrapolated or estimated. When a prompt generates timestamps for Document History entries, use the timestamp from the request or prompt submission metadata.

Agents often generate timestamps by estimating the current time from their training data or internal clock. These estimates drift — sometimes by hours or days. The request metadata contains the actual submission timestamp, which is the authoritative source for Document History entries.

Verifiable from artifact: check that Document History timestamps in files modified by the prompt match the timestamp from the prompt's request metadata. If timestamps are ahead of or behind the request time, the prompt violated this rule.

**BAD** (timestamp extrapolated, runs ahead of wall clock):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Update the Document History section of `_SPEC_Auth.md` with today's changes.
```
`````
Result: Document History entry reads `[2026-03-20 14:30]` but the prompt was submitted at `2026-03-19 10:15`. The agent estimated the timestamp and was off by over a day.

**GOOD** (timestamp from request metadata):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Update the Document History section of `_SPEC_Auth.md` with today's changes. Use the timestamp from this prompt's request metadata for the Document History entry.
```
`````
Result: Document History entry reads `[2026-03-19 10:15]` matching the prompt submission timestamp.

## PRMT-CT-14: Banned-Term Sweep Recording

When recording a banned-term sweep in Document History or findings, describe the pattern shape (e.g., "swept for banned terms in filenames"), not the literal banned pattern. Spelling banned literals in the recording plants them in the document.

Banned terms are banned because they should not appear in the document. Recording the literal banned pattern in a Document History entry or findings card defeats the purpose of the sweep — the banned term is now in the document, in the sweep record itself.

Verifiable from artifact: check Document History entries and findings card entries that record banned-term sweeps. If the entry contains the literal banned pattern instead of a description of the pattern shape, the prompt violated this rule.

**BAD** (sweep record spells the banned literal):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Sweep the codebase for banned terms. Record the sweep in Document History.
```
`````
Result: Document History entry reads "Swept for `deprecated_api_v2` in filenames" — the banned term `deprecated_api_v2` is now in the document.

**GOOD** (sweep record describes pattern shape, does not spell the literal):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Sweep the codebase for banned terms. Record the sweep in Document History. Describe the pattern shape, do not spell the banned literal.
```
`````
Result: Document History entry reads "Swept for banned terms in filenames" — no banned literal appears in the record.

## PRMT-HS-10: Spec-Code Consistency Check

When a prompt changes code that has an associated spec, the Verify section must include a spec-code consistency check for the changed clauses. The Verify section names the spec file and the clauses affected by the code change.

Specs and code drift apart when one changes without the other. A prompt that modifies code without checking the spec leaves the spec stale. The spec-code consistency check ensures the prompt verifies that the spec still accurately describes the code after the change.

Verifiable from artifact: check that the Verify section of prompts modifying code with an associated spec names the spec file and the clauses affected by the code change. If the Verify section does not mention the spec file, the prompt violates this rule.

**BAD** (code change without spec consistency check):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Change the token expiration from 30 minutes to 60 minutes in `src/auth/issuer.ts`.

Verify: Run `npx jest tests/unit/auth.test.ts`. All tests pass.
```
`````
Result: Code changed, spec `_SPEC_Auth.md` still says "tokens expire after 30 minutes". Spec is now stale.

**GOOD** (code change with spec consistency check):
`````markdown
```
Read `__CARD_00-Rules.md`. Treat earlier conversation as compacted. Step P2-S1.

Change the token expiration from 30 minutes to 60 minutes in `src/auth/issuer.ts`.

Verify: Run `npx jest tests/unit/auth.test.ts`. All tests pass. Check `_SPEC_Auth.md` section 3.2 (Token Expiration) still matches the new 60-minute TTL. Update spec if drifted.
```
`````
Result: Code changed, spec verified and updated if needed. Spec-code consistency maintained.
