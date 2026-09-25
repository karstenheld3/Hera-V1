---
description: Create prompt queue files (_PROMPTS_[NN]-[Topic].md) for sequential headless execution
auto_execution_mode: 3
---

# Write Prompts Workflow

Create `_PROMPTS_[NN]-[Topic].md` files containing an ordered list of prompts. Each prompt is a fenced code block. Prompts execute sequentially as turns of ONE session.

**Goal**: Validated `_PROMPTS_[NN]-[Topic].md` file with focused, verifiable prompts

**Why**: Headless prompts must be complete on first submission - no human correction loop

## Required Skills

- @skills:write-documents `PROMPTS_TEMPLATE.md` for file skeleton (copy and fill)
- @skills:write-documents `PROMPTS_GUIDES.md` for strategic approach (read BEFORE writing)
- @skills:write-documents `PROMPTS_RULES.md` for output verification (PRMT-* rules)
- @skills:write-documents `PROMPTS_ROBUSTNESS_GUIDES.md` for hang-prevention clause template, banned command lists, and inter-prompt problem filing

## MUST-NOT-FORGET

- First non-empty line MUST be an opening fence, Commentary (heading/notes), or optional Execution Frontmatter (per PRMT-FT-08). No other YAML frontmatter.
- Optional Execution Frontmatter (PRMT-FT-08): YAML block at file start with `intended_model`, `context_window_size`, `effort`, `prompt_system`. Execution engine MAY honor or override. Omit if no hints needed.
- Fence length: 3-9 backticks per prompt. Outer fence MUST exceed deepest inner fence
- `---` separator between every pair of consecutive prompts
- Commentary (headings, notes) only between `---` and next fence - never sent to model. Commentary notes MUST be in HTML comments (`<!-- ... -->`), headings as plain Markdown
- Heading recommendation (PRMT-FT-07): use `## Prompt N - [title]` before each prompt. If headings are used, ALL prompts MUST have headings
- Prompt Marker (PRMT-FT-10): all prompt sequences MUST include a human-readable prefix `[ NN / NN ]` as first line inside each prompt's fence, not in the heading. When using a planning document (PRMT-SC-06), marker includes plan summary: `Human Readable Prefix [ NN / NN ] - [plan step ID] [brief summary]`
- At least one prompt per file
- **NEVER modify tracking documents** (PROGRESS.md, PROBLEMS.md, NOTES.md, FAILS.md). Write-* workflows create NEW files only.
- Pre-Write Privacy Gate (`agent-behavior.md`): General-purpose documents → all content generic. ILLUSTRATIVE content → examples generic.
- **Rule precedence**: PRMT-CT-04 (objectives not steps) overrides PRMT-CT-05 (precision). See PRMT-CT-04 for details.
- **Workflow references** (PRMT-CT-10): When a workflow appears in prompt prose as a reference (no execution verb, no execution requirement), wrap in backticks (`/write-prompts`). When calling a workflow to execute (execution verb present: run, use, execute, call, invoke, perform, apply, do), use a standalone line with the slash command without backticks (PRMT-CT-08). Execution verb + backticks = violation.
- **Leverage existing workflows** (PRMT-CT-11): Before writing prompts, scan `[AGENT_FOLDER]/workflows/` frontmatters to find workflows relevant to the task. Load matching workflows entirely. Design prompts that reference or invoke existing workflows instead of reinventing their logic in prompt prose. If user explicitly requests prompt system independence, omit `prompt_system` from frontmatter (PRMT-FT-09) and do not reference workflows.
- **NEVER self-execute prompt files** (PRMT-EX-02): After writing a prompt file, deliver it to the user or execution engine. Do NOT run all prompts in a single response. Each prompt is a separate turn for an execution engine (Lana, headless runner). Self-executing circumvents per-turn context engineering and compute allocation, defeating the purpose of prompt files.
- **Execution authority** (PRMT-EX-03): Prompts in `_PROMPTS_*.md` files carry implicit execution authority. Agent must complete without asking for confirmation. Confirmation pauses hang the sequence.
- **Self-contained prompts** (PRMT-SC-01): Every prompt must start with a context-loading directive, "treat earlier conversation as compacted" statement, and step identifier. No prompt may reference "the previous step" without naming where output lives in a file (PRMT-SC-02).
- **Idempotency constraints** (PRMT-SC-03): Implementation prompts must include "re-running this prompt must not corrupt state or waste cost" in constraints.
- **Chain length limit** (PRMT-SC-04): Sequences must stay under 6 steps. Longer workflows split into sub-chains with checkpoints.
- **Effort-based partitioning** (PRMT-SC-05): Frontmatter must specify `effort` level. Prompt count must match effort budget (low effort = more tightly scoped prompts, high effort = fewer broader prompts). See `PROMPTS_GUIDES.md` Section 1c.
- **Planning document anchor** (PRMT-SC-06): Prompt sequences from planning documents (TASKS, STRUT) must reference the document by filename and step ID. See `PROMPTS_GUIDES.md` Section 1d.
- **Hang-safety clause** (PRMT-HS-01): Every implementation prompt MUST include a hang-safety clause in Constraints: prohibition (no stdin/pager/unbounded child), project-specific banned list, time caps, on-cap behavior. See `PROMPTS_ROBUSTNESS_GUIDES.md` for template, project-specific banned lists, and problem-filing directive.
- **Verification specificity** (PRMT-HS-07): Verification sections must name specific test files when code changes affect tests, include residual sweeps when concepts are removed, and confirm prior steps when dependencies exist.
- **Prior-step verification** (PRMT-HS-08): Dependent prompts must verify the prior step is done before proceeding.
- **Agent tools over shell** (PRMT-CT-12): Prompt bodies must use agent tool directives (grep_search, read_file, find_by_name, code_search) for file search/read, not shell commands. Shell commands for file operations only in Verify sections for residual sweeps.
- **Targeted test scope** (PRMT-HS-09): Verification must run specific test files during implementation, not the full suite. Full suite only in final verification.
- **Interleaved verification** (PRMT-SQ-04): Sequences with 4+ implementation prompts must include verification prompts every 2-3 implementation prompts. Verification prompts run `/verify` against the planning document and `/fix` for gaps. They do NOT count toward chain length limit.

## Context Branching

This workflow has two modes. Determine the mode from the user's request:

- **Compose mode** (default) - Write prompts from scratch based on user description
  - Trigger: `/write-prompts [description]`
  - Steps: classify task, decompose, write, verify

- **From Template mode** - Generate a filled prompts file from a `_PROMPTS_*_TEMPLATE.md`
  - Trigger: `/write-prompts from template [path/to/template]`
  - Steps: read template, collect placeholder values, generate filled instance, verify
  - The template's top comment block contains the placeholder registry and usage instructions
  - Output: `_PROMPTS_[NN]-[Topic]-[Instance].md` following the template's naming convention

## Prerequisites

### Compose mode

- User has described one or more prompts to execute sequentially
- Determine if prompts contain code blocks (affects fence length)

### From Template mode

- User has provided a path to a `_PROMPTS_*_TEMPLATE.md` file
- User has provided (or can provide) case-specific context for placeholder values

# COMPOSE MODE

## Step 1: Read PROMPTS_GUIDES.md and Scan Existing Workflows

Read `PROMPTS_GUIDES.md` from @skills:write-documents. Classify the task, decide decomposition, plan state flow between prompts.

**Hang-safety planning**: Read `PROMPTS_ROBUSTNESS_GUIDES.md` from @skills:write-documents. Identify project-specific hang risks (commands that wait on stdin, launch pagers, run unbounded children). Build the banned command list for the hang-safety clause. Determine time caps for each command type in the sequence.

**Findings-card planning**: Designate a `__CARD_[TOPIC]-Findings.md` card for the sequence. Every implementation prompt includes a `Findings card:` directive pointing to this card. The card is loaded at prompt startup and updated at end-of-prompt with glitches, spec-code mismatches, and unexpected findings. Session PROBLEMS.md records problems encountered during prompt execution that must be approached later (blockers, deferred issues).

**Effort-based partitioning**: Read the frontmatter `effort` level (PRMT-SC-05). Scope prompts to the effort budget: at low effort, each prompt handles one file or one edit; at high effort, a single prompt can handle multi-file analysis and implementation. Match prompt count to effort level. See `PROMPTS_GUIDES.md` Section 1c.

**Planning document check**: Verify a TASKS or STRUT planning document exists for the task. If it exists, reference it by filename and step ID in each prompt's self-contained opening (PRMT-SC-06). If no planning document exists, the prompt file itself serves as the tracking document. See `PROMPTS_GUIDES.md` Section 1d.

Then scan `[AGENT_FOLDER]/workflows/` frontmatters (the `description` field) to find workflows relevant to the task. Load matching workflows entirely to understand their structure, steps, and dispatch patterns before designing prompts (PRMT-CT-11). Design prompts that reference or invoke these workflows instead of reinventing their logic.

## Step 2: Determine File Location and Name

- Filename: `_PROMPTS_[NN]-[Topic].md`
- `[NN]` = zero-padded 2-digit sequence number starting at `01` (PRMT-NM-03). When creating multiple files in one invocation, assign sequential numbers. When adding to a folder with existing prompt files, continue from the highest existing number + 1
- `[Topic]` = CamelCase description of prompt purpose
- Location: session folder (default), workspace root, or user-specified path
- Examples: `_PROMPTS_01-SetupProject.md`, `_PROMPTS_02-MigrateAuth.md`, `_PROMPTS_01-AnalyzePerformance.md`

## Step 3: Select Fence Length Per Prompt

For each prompt, find the deepest inner fence and set the outer fence one longer.

- Prompt has no code blocks → 3 backticks
- Prompt contains ``` blocks → 4+ backtick outer fence
- Prompt contains ```` blocks (e.g. markdown examples with ``` inside) → 5+ backtick outer fence
- Maximum outer fence: 9 backticks. If deeper nesting needed, restructure the prompt.

## Step 4: Write Prompts File

**Format overview** (5-prompt example with interleaved verification, optional frontmatter and headings, per PRMT-FT-07/08, PRMT-SQ-04):

`````markdown
---
intended_model: claude-sonnet-4-5
context_window_size: 200k
effort: high
prompt_system: IPPS
---

## Prompt 1 - Setup

```
Prompt [ 01 / 07 ] - [plan step ID] [brief summary]
Read [context-loading directive: files to read]. Treat earlier conversation as compacted. Step [step identifier].
Planning document: [TASKS or STRUT filename], step [ID].

First prompt text. Plain instruction, no code blocks inside.

Constraints:
- [What NOT to do]
- Execute without asking for confirmation
- Re-running this prompt must not corrupt state or waste cost
- Hang safety: no command may wait for stdin, a pager, or an unbounded child. Banned: [project-specific list]. [Time cap] cap. On cap: kill, record in PROBLEMS.md, continue.

Verify: [Machine-checkable done criteria]
```

---

## Prompt 2 - Implement Core

<!-- Optional notes explaining the next prompt's purpose. -->

````
Prompt [ 02 / 07 ] - [plan step ID] [brief summary]
Read [context-loading directive: files to read]. Treat earlier conversation as compacted. Step [step identifier].
Planning document: [TASKS or STRUT filename], step [ID].

Second prompt with a code block inside:
```python
print("hello")
```

Constraints:
- [What NOT to do]
- Execute without asking for confirmation
- Re-running this prompt must not corrupt state or waste cost
- Hang safety: no command may wait for stdin, a pager, or an unbounded child. Banned: [project-specific list]. [Time cap] cap. On cap: kill, record in PROBLEMS.md, continue.

Verify: [Observable success criteria]
````

---

## Verification Checkpoint 1

<!-- Verify prompts 1-2 against STRUT before continuing. -->

```
Prompt [ 03 / 07 ] - Verification checkpoint after prompts 1-2
Read [rules card] and [STRUT filename]. Treat earlier conversation as compacted. Verification checkpoint after prompts 1-2.

/verify

current state against [STRUT filename] for prompts executed so far.

/fix

all gaps and remaining work.
```

---

## Prompt 3 - Implement Next Feature

```
Prompt [ 04 / 07 ] - [plan step ID] [brief summary]
Read [context-loading directive: files to read]. Treat earlier conversation as compacted. Step [step identifier].
Planning document: [TASKS or STRUT filename], step [ID].

Third implementation prompt.

Constraints:
- [What NOT to do]
- Execute without asking for confirmation
- Re-running this prompt must not corrupt state or waste cost
- Hang safety: no command may wait for stdin, a pager, or an unbounded child. Banned: [project-specific list]. [Time cap] cap. On cap: kill, record in PROBLEMS.md, continue.

Verify: [Machine-checkable done criteria]
```

---

## Prompt 4 - Finalize

```
Prompt [ 05 / 07 ] - [plan step ID] [brief summary]
Read [context-loading directive: files to read]. Treat earlier conversation as compacted. Step [step identifier].
Planning document: [TASKS or STRUT filename], step [ID].

Fourth implementation prompt.

Constraints:
- [What NOT to do]
- Execute without asking for confirmation
- Re-running this prompt must not corrupt state or waste cost
- Hang safety: no command may wait for stdin, a pager, or an unbounded child. Banned: [project-specific list]. [Time cap] cap. On cap: kill, record in PROBLEMS.md, continue.

Verify: [Machine-checkable done criteria]
```

---

## Verification Checkpoint 2

<!-- Verify prompts 3-4 against STRUT before final prompt. -->

```
Prompt [ 06 / 07 ] - Verification checkpoint after prompts 3-4
Read [rules card] and [STRUT filename]. Treat earlier conversation as compacted. Verification checkpoint after prompts 3-4.

/verify

current state against [STRUT filename] for prompts executed so far.

/fix

all gaps and remaining work.
```

---

## Prompt 5 - Final Verification

```
Prompt [ 07 / 07 ] - [plan step ID] [brief summary]
Read [context-loading directive: files to read]. Treat earlier conversation as compacted. Step [step identifier].
Planning document: [TASKS or STRUT filename], step [ID].

Final verification prompt. Run the full test suite to confirm no regressions.

Constraints:
- Execute without asking for confirmation
- Re-running this prompt must not corrupt state or waste cost
- Hang safety: no command may wait for stdin, a pager, or an unbounded child. Banned: [project-specific list]. [Time cap] cap. On cap: kill, record in PROBLEMS.md, continue.

Verify: Run `bun test --timeout 20000` non-blocking with a 10-minute cap. All tests pass.
```
`````

**Format rules:**
1. First non-empty line = optional Execution Frontmatter (per PRMT-FT-08), Commentary (heading/notes), or opening fence. No other YAML frontmatter
2. Each prompt = opening fence + prompt text + closing fence
3. Closing fence = line with >= N backticks (where N = opening fence length)
4. `---` on its own line between consecutive prompts
5. Commentary (headings, paragraphs, lists) allowed before the first prompt and between `---` and next opening fence. Commentary notes MUST be in HTML comments (`<!-- ... -->`), headings as plain Markdown
6. Heading recommendation (PRMT-FT-07): use `## Prompt N - [title]` before each prompt. If headings are used, ALL prompts MUST have headings
7. Prompt Marker (PRMT-FT-10): all prompt sequences MUST include a human-readable prefix `[ NN / NN ]` as first line inside each prompt's fence. When using a planning document (PRMT-SC-06), marker includes plan summary: `Human Readable Prefix [ NN / NN ] - [plan step ID] [brief summary]`
8. Info string after opening fence (e.g. `` ```text ``) is optional and ignored by executor
9. Prompts execute in file order
10. Execution Frontmatter is optional - omit entirely if no execution hints needed
11. Verification prompts (PRMT-SQ-04): sequences with 4+ implementation prompts MUST include verification checkpoints every 2-3 implementation prompts. Use heading `## Verification Checkpoint N`. Verification prompts do NOT count toward chain length limit (PRMT-SC-04)

## Step 4a: Insert Verification Checkpoints

If the sequence has 4 or more implementation prompts, insert verification checkpoints every 2-3 implementation prompts (PRMT-SQ-04):

1. Count implementation prompts (exclude verification prompts from the count)
2. Insert a `## Verification Checkpoint N` prompt after every 2-3 implementation prompts
3. Each checkpoint runs `/verify` against the planning document and `/fix` for gaps
4. Verification prompts are self-contained (PRMT-SC-01): read rules card and planning document
5. Verification prompts do NOT count toward chain length limit (PRMT-SC-04)
6. Use `## Verification Checkpoint N` heading (not `## Prompt N`) to distinguish from implementation prompts

**Checkpoint placement examples**:
- 4 implementation prompts: checkpoint after prompt 2
- 5 implementation prompts: checkpoints after prompt 2 and after prompt 4
- 6 implementation prompts: checkpoints after prompt 2 and after prompt 4 (or split into sub-chains per PRMT-SC-04)

**Checkpoint prompt template**:
```
Read [rules card] and [STRUT filename]. Treat earlier conversation as compacted. Verification checkpoint after prompts [N]-[M].

/verify

current state against [STRUT filename] for prompts executed so far.

/fix

all gaps and remaining work.
```

## Step 5: Verify

Check output against all PRMT-* rules in `PROMPTS_RULES.md`:

- [ ] Format (FT): PRMT-FT-01 through PRMT-FT-10
- [ ] Structure (ST): PRMT-ST-01 through PRMT-ST-05
- [ ] Sequence (SQ): PRMT-SQ-01 through PRMT-SQ-04
- [ ] Content (CT): PRMT-CT-01 through PRMT-CT-14
- [ ] Self-Contained (SC): PRMT-SC-01 (self-contained opening), PRMT-SC-02 (no conversation dependency), PRMT-SC-03 (idempotency constraint), PRMT-SC-04 (chain length under 6), PRMT-SC-05 (effort and model specification), PRMT-SC-06 (planning document reference)
- [ ] Execution (EX): PRMT-EX-01 (one prompt per turn), PRMT-EX-02 (no self-execution), PRMT-EX-03 (execution authority)
- [ ] Hang Safety (HS): PRMT-HS-01 through PRMT-HS-10
- [ ] Robustness (RB): PRMT-RB-01 through PRMT-RB-07 (findings card designated, directive in every implementation prompt, card read at startup, glitches filed before commit, entry format, card system integration, PROBLEMS.md distinction)
- [ ] Naming (NM): PRMT-NM-01 (filename pattern `_PROMPTS_[NN]-[Topic].md`), PRMT-NM-02 (Topic describes purpose), PRMT-NM-03 ([NN] zero-padded sequence number)

### Step 5b: Workflow Call Formatting Pass

Scan every fenced prompt for workflow names (patterns matching `/[a-z-]+`). For each occurrence:

1. Standalone line without backticks, slash command alone with arguments on following line(s) → OK (execution, PRMT-CT-08)
2. Backticks in prose, NO execution verb → OK (reference, PRMT-CT-10)
3. Backticks in prose, WITH execution verb (run, use, execute, call, invoke, perform, apply, do) → VIOLATION: rewrite as standalone line without backticks, arguments on next line

Execution verbs: run, use, execute, call, invoke, perform, apply, do

Example fix:
- BAD: "Use the `/sync` workflow to sync files."
- GOOD: "Sync files:" + standalone `/sync` line + arguments on next line

### Step 5c: Self-Contained Opening Pass

Scan every fenced prompt for the self-contained opening (PRMT-SC-01). Each prompt must contain:

1. A context-loading directive naming files or cards to read
2. "Treat earlier conversation as compacted" statement
3. A step identifier (STRUT step, task ID, or sequence position)

If any prompt is missing any of the three elements, add them. Check that no prompt references "the previous step" or "as discussed above" without naming where the output lives in a file (PRMT-SC-02).

### Step 5d: Tool Preference and Test Scope Pass

Scan every fenced prompt for shell commands used for file operations and full-suite test runs:

1. **Tool preference** (PRMT-CT-12): Scan prompt bodies (excluding Verify sections) for shell file-operation commands: `Select-String`, `Get-ChildItem`, `Get-Content`, `cat`, `grep`, `find`, `rg.exe`. If found outside Verify sections, rewrite as agent tool directives ("Search for X using the grep_search tool", "Read `file.ts`", "Find all .ts files using the find_by_name tool").
2. **Test scope** (PRMT-HS-09): Scan Verify sections for bare `bun test`, `npm test`, or equivalent full-suite commands in implementation prompts. If found, replace with specific test file paths. Full suite is acceptable only in a prompt explicitly marked as final verification.

### Step 5e: Interleaved Verification Pass

Check whether the sequence needs interleaved verification prompts (PRMT-SQ-04):

1. Count implementation prompts (exclude verification prompts from the count)
2. If 4+ implementation prompts: check for `## Verification Checkpoint N` headings between implementation prompts containing `/verify` and `/fix` workflow calls
3. If missing: insert verification checkpoints every 2-3 implementation prompts using the template from Step 4a
4. Verify checkpoint prompts are self-contained (PRMT-SC-01), do NOT count toward chain length (PRMT-SC-04), and use `## Verification Checkpoint N` heading (not `## Prompt N`)

# FROM TEMPLATE MODE

## Step T1: Read Template

Read the `_PROMPTS_*_TEMPLATE.md` file specified by the user. Extract:

1. **Placeholder registry** from the top comment block - list of all `[PLACEHOLDER]` values with descriptions
2. **Instance naming convention** - how the filled file should be named
3. **Usage instructions** - any special filling rules
4. **Conditional sections** - prompts or sections marked `<!-- Conditional: ... -->` that may be included or removed based on context

## Step T2: Collect Placeholder Values

For each placeholder in the registry:

1. Check if the user provided the value in their request or conversation history
2. If not provided: derive from context (session files, PROBLEMS.md, SPEC, IMPL) by reading the referenced files
3. If not derivable: list the missing placeholders and their descriptions - the user must provide them
4. Do not guess placeholder values. Every value must be sourced from user input or workspace files.

## Step T3: Generate Filled Instance

1. Copy the template content
2. Remove ALL XML comments (template annotations are not part of the output)
3. Replace ALL `[PLACEHOLDER]` values with the collected case-specific data
4. Resolve conditional sections: remove the branch that does not apply based on the collected values (e.g., remove BUG pipeline when category = CHANGE)
5. Verify fence depths are still correct after modifications (PRMT-FT-02)
6. Save as `_PROMPTS_[NN]-[Topic]-[Instance].md` following the template's naming convention

## Step T4: Verify Filled Instance

The filled file must pass all PRMT-* rules as a standalone prompts file:

- [ ] PRMT-FT-01: First non-empty line is optional frontmatter (PRMT-FT-08), Commentary, or opening fence
- [ ] PRMT-FT-02: Fence lengths correct (outer > deepest inner)
- [ ] PRMT-FT-03: `---` separator between every pair of consecutive prompts
- [ ] PRMT-FT-04: Commentary notes in HTML comments (`<!-- ... -->`), headings as plain Markdown, only between separator and next fence (or before first fence)
- [ ] PRMT-FT-07: If headings are used, all prompts have headings (MUST)
- [ ] PRMT-FT-08: If frontmatter present, it is at file start with valid keys
- [ ] PRMT-FT-10: Each prompt includes a human-readable prefix `[ NN / NN ]` Prompt Marker as first line inside fence; when using a planning document, marker includes plan summary: `Human Readable Prefix [ NN / NN ] - [plan step ID] [brief summary]`
- [ ] PRMT-ST-01..05: Each prompt has objective, constraints (if implementation), verification, single reasoning mode, density limit
- [ ] PRMT-SQ-01..04: No contradictions, explicit dependencies, commentary documents state, interleaved verification prompts for 4+ implementation prompt sequences
- [ ] PRMT-CT-01..14: Specific objectives, negative constraints, observable verification, workflow execution vs reference distinction (execution verb = standalone without backticks, no execution verb = backticks), existing workflows leveraged, agent tools over shell for file operations, timestamp from request metadata, banned-term sweep recording
- [ ] PRMT-EX-01..03: One prompt per turn, no self-execution by writing agent, execution authority
- [ ] PRMT-HS-01: Implementation prompts include hang-safety clause
- [ ] PRMT-HS-02: Banned command list is project-specific
- [ ] PRMT-HS-03..06: Time caps, on-cap behavior, process cleanup, no interactive commands
- [ ] PRMT-HS-07..08: Specific test files in verification, prior-step verification
- [ ] PRMT-HS-09: Targeted test scope — specific test files, not full suite, in implementation prompts
- [ ] PRMT-HS-10: Spec-code consistency check in Verify when prompt changes code with associated spec
- [ ] PRMT-CT-12: No shell commands for file search/read in prompt bodies — agent tools only
- [ ] PRMT-RB-01: Findings card designated for the sequence
- [ ] PRMT-RB-02: Findings-card directive in every implementation prompt
- [ ] PRMT-RB-03..06: Card read at startup, glitches filed before commit, entry format, card system integration
- [ ] PRMT-RB-07: Session PROBLEMS.md records deferred problems, not detailed glitch logs
- [ ] No unresolved `[PLACEHOLDER]` values remain in the output
- [ ] No XML comments remain in the output
- [ ] Privacy gate: no real user data leaked into the filled instance

# OUTPUT

## Compose mode

Validated `_PROMPTS_[NN]-[Topic].md` file in target location.

## From Template mode

Validated `_PROMPTS_[NN]-[Topic]-[Instance].md` file with all placeholders resolved, ready for sequential execution.

## Quality Gate

- [ ] All PRMT-* rules pass (FT-01 through FT-10, ST, SQ, CT-01 through CT-14, SC, EX-01 through EX-03, HS-01 through HS-10, RB, NM-01 through NM-03)
- [ ] Filename includes zero-padded sequence number `_PROMPTS_[NN]-[Topic].md` (PRMT-NM-03)
- [ ] Workflow call formatting: no execution verb + backticks combinations remain (PRMT-CT-08)
- [ ] Self-contained opening in every prompt (PRMT-SC-01): context-loading directive, "treat earlier conversation as compacted", step identifier
- [ ] No conversation dependency: no "the previous step" without file path (PRMT-SC-02)
- [ ] Idempotency constraints in implementation prompts (PRMT-SC-03)
- [ ] Chain length under 6 steps or sub-chains with checkpoints (PRMT-SC-04)
- [ ] Effort level in frontmatter, prompt count matches effort budget (PRMT-SC-05)
- [ ] Planning document referenced by filename and step ID (PRMT-SC-06)
- [ ] No shell commands for file search/read in prompt bodies — agent tools only (PRMT-CT-12)
- [ ] Verification runs specific test files, not full suite, during implementation steps (PRMT-HS-09)
- [ ] Sequences with 4+ implementation prompts include interleaved verification checkpoints (PRMT-SQ-04)
- [ ] Privacy gate applied (no real project data in examples)
- [ ] Fence depths verified (outer > deepest inner per prompt)
- [ ] **From Template mode**: Zero unresolved placeholders
- [ ] **From Template mode**: Zero remaining XML comments
- [ ] **From Template mode**: All conditional sections resolved
