# Prompts Checks

Audits prompt writing process discipline and prompt sequence quality improvement.

**Evidence sources:** conversation logs, generated prompt files, frontmatter, planning documents

## Check Index

Process Discipline (PD)
- PRMT-PD-01: Agent read PROMPTS_GUIDES.md before writing prompts
- PRMT-PD-02: Agent scanned existing workflows before designing prompts
- PRMT-PD-03: Agent checked effort budget when partitioning prompts
- PRMT-PD-04: Agent referenced planning document in prompt sequence
- PRMT-PD-05: Agent verified prompt file against PRMT-* rules after writing
- PRMT-PD-06: Agent included Prompt Markers in all prompt sequences

Quality Improvement (QI)
- PRMT-QI-01: Is each prompt self-contained?
- PRMT-QI-02: Does the sequence stay under 6 steps?
- PRMT-QI-03: Are prompts scoped to the effort budget?
- PRMT-QI-04: Do implementation prompts include idempotency constraints?
- PRMT-QI-05: Does the sequence use context cards for shared state?
- PRMT-QI-06: Does every implementation prompt include a hang-safety clause?
- PRMT-QI-07: Does the sequence designate a findings card for inter-prompt problem filing?
- PRMT-QI-08: Do prompt bodies use agent tool directives instead of shell commands for file operations?
- PRMT-QI-09: Do verification sections run specific test files instead of full suite during implementation?
- PRMT-QI-10: Do sequences with 4+ implementation prompts include interleaved verification checkpoints?
- PRMT-QI-11: Do implementation prompts include "Execute without asking for confirmation" in Constraints?
- PRMT-QI-12: Do Document History timestamps use request metadata, not extrapolated times?
- PRMT-QI-13: Does the Verify section check spec-code consistency when the prompt changes code with an associated spec?

## Process Discipline (PD)

### PRMT-PD-01: Read GUIDES Before Writing

- Action: Agent read `PROMPTS_GUIDES.md` before writing prompts
- Evidence: conversation log shows `PROMPTS_GUIDES.md` read or referenced before prompt file creation
- Failure indicator: prompts written without any reference to GUIDES content; prompt structure violates GUIDE guidance (e.g., missing constraints, no verification criteria)
- References: PRMT-CT-11

### PRMT-PD-02: Scanned Existing Workflows

- Action: Agent scanned existing workflows in `[AGENT_FOLDER]/workflows/` before designing prompts
- Evidence: conversation log shows workflow frontmatters read or workflows loaded; prompt file references or invokes matching workflows
- Failure indicator: prompts reinvent workflow logic in prose instead of referencing existing workflows (e.g., manual sync steps instead of `/sync`)
- References: PRMT-CT-11

### PRMT-PD-03: Checked Effort Budget

- Action: Agent checked effort budget when partitioning prompts
- Evidence: frontmatter includes `effort` level; prompt count is consistent with effort scope (low effort = more tightly scoped prompts, high effort = fewer broader prompts)
- Failure indicator: 8 prompts at low effort for a task that fits 2 prompts at high effort; 1 prompt at low effort for a multi-step pipeline requiring 5 prompts
- References: PRMT-SC-05

### PRMT-PD-04: Referenced Planning Document

- Action: Agent referenced a planning document (TASKS or STRUT) in the prompt sequence
- Evidence: prompts reference the planning document by filename and step ID in the self-contained opening
- Failure indicator: no planning document referenced; prompts use "the previous step" without naming where output lives; unanchored sequence with no progress tracking
- References: PRMT-SC-06

### PRMT-PD-05: Verified Against Rules

- Action: Agent verified the prompt file against PRMT-* rules after writing
- Evidence: conversation log shows verification step executed; review checklist completed or `/verify` workflow run
- Failure indicator: no verification evidence; prompt file contains rule violations that a verify pass would have caught (missing separators, no constraints, no verification criteria)
- References: PRMT-ST-01 through PRMT-ST-05

### PRMT-PD-06: Prompt Markers in All Sequences

- Action: Agent included `Human Readable Prefix [ NN / NN ] - [brief summary]` Prompt Markers inside each prompt's fence as first line for all prompt sequences; the summary matches the heading text; when using a planning document (PRMT-SC-06), the summary includes plan phase/step references: `Human Readable Prefix [ NN / NN ] - [plan step ID] [brief summary]`
- Evidence: each prompt's first line inside the fence contains a zero-padded Prompt Marker with current count, total count, and a summary; an empty line follows the marker before the prompt content; when a planning document is referenced, the summary includes plan phase/step references matching the heading text
- Failure indicator: any prompt sequence with no Prompt Marker inside fence; marker in heading instead of inside fence; marker without summary; inconsistent zero-padding; no empty line after marker; planning document used but summary lacks plan phase/step references
- References: PRMT-FT-10

## Quality Improvement (QI)

### PRMT-QI-01: Self-Containment Quality

- Question: Is each prompt self-contained? Could it execute correctly after a context reset with no prior conversation history?
- Improvement tip: Add a context-loading directive at the start of each prompt naming the files to read. Add "Treat earlier conversation as compacted" statement. Replace "the previous step" references with explicit file paths. Add a step identifier for progress tracking.

### PRMT-QI-02: Chain Length Quality

- Question: Does the prompt sequence stay under 6 steps? If longer, are sub-chains with checkpoints used?
- Improvement tip: Split sequences longer than 6 prompts into sub-chains. Each sub-chain completes, commits, and the next sub-chain starts fresh with its own self-contained opening. Add a checkpoint comment documenting where one sub-chain ends and the next begins.

### PRMT-QI-03: Effort Budget Quality

- Question: Are prompts scoped to the effort budget? Does the prompt count match the effort level specified in frontmatter?
- Improvement tip: At low effort, scope each prompt tighter — one file, one edit, one search. At high effort, consolidate related work into fewer, broader prompts. If the prompt count feels too high for the effort level, merge related prompts. If too low, split overloaded prompts.

### PRMT-QI-04: Idempotency Quality

- Question: Do implementation prompts include idempotency constraints? Is re-running each prompt safe?
- Improvement tip: Add "Re-running this prompt must not corrupt state or waste cost" to the Constraints section of each implementation prompt. For prompts that create files, add: "if the output file already exists and passes validation, skip creation." For prompts that call APIs, add: "check if cached results exist before re-calling."

### PRMT-QI-05: Context Card Usage

- Question: Does the sequence use context cards for shared state instead of conversation references? Is shared information stored in durable files?
- Improvement tip: Create `__CARD_*.md` files for shared information that does not have a stable home in an existing document. Each prompt reads and updates the relevant cards. Use references (document path + line numbers) when information has a stable home. Avoid duplicating content across prompts — store once, reference by path.

### PRMT-QI-06: Hang-Safety Clause Quality

- Question: Does every implementation prompt include a hang-safety clause with project-specific banned commands, time caps, and on-cap behavior?
- Improvement tip: Add a hang-safety clause to the Constraints section of each implementation prompt. Reference `__CARD_01-Robustness.md` for the banned list instead of repeating it in every prompt. See `PROMPTS_EXAMPLE_02-RobustnessCard.md` for a complete robustness card example.

### PRMT-QI-07: Findings Card Quality

- Question: Does the sequence designate a findings card? Do prompts load it at startup and file glitches before commit?
- Improvement tip: Create `__CARD_[TOPIC]-Findings.md` at sequence start. Add a `Findings card:` directive to every implementation prompt. File glitches in the card before end-of-prompt commit. Use the six-field entry format (severity, expected, actual, root cause, resolution, prevention). See `PROMPTS_EXAMPLE_03-FindingsCard.md` for a complete findings card example.

### PRMT-QI-08: Tool Preference Quality

- Question: Do prompt bodies use agent tool directives (grep_search, read_file, find_by_name, code_search) for file search/read operations instead of shell commands?
- Evidence: scan prompt bodies (excluding Verify sections) for shell file-operation commands (Select-String, Get-ChildItem, Get-Content, cat, grep, find, rg.exe); none found outside Verify sections
- Failure indicator: prompt body contains `Select-String -Recurse`, `Get-ChildItem -Recurse`, `Get-Content` for file reading; shell commands used where agent tools exist
- Improvement tip: Replace shell file-operation commands in prompt bodies with agent tool directives: "Search for X using the grep_search tool", "Read `file.ts`", "Find all .ts files using the find_by_name tool". Reserve shell commands for Verify sections (residual sweeps) and process execution (builds, tests, git).
- References: PRMT-CT-12

### PRMT-QI-09: Targeted Test Scope Quality

- Question: Do verification sections in implementation prompts run specific test files instead of the full suite?
- Evidence: scan Verify sections for bare `bun test`, `npm test`, or equivalent full-suite commands in implementation prompts; full suite only in explicitly marked final verification
- Failure indicator: implementation prompt Verify section contains bare `bun test` or `npm test` without specific file paths; full suite run during implementation steps
- Improvement tip: Replace bare `bun test` with `bun test tests/unit/auth.test.ts tests/unit/token_validator.test.ts` (specific files). Reserve full suite for the final verification step of the sequence, with a time cap and non-blocking execution.
- References: PRMT-HS-09

### PRMT-QI-10: Interleaved Verification Prompts Quality

- Question: If the sequence has 4+ implementation prompts, does it include verification checkpoints every 2-3 implementation prompts?
- Evidence: count implementation prompts (excluding verification prompts); if 4+, check for `## Verification Checkpoint N` headings between implementation prompts containing `/verify` and `/fix` workflow calls
- Failure indicator: 5 implementation prompts with no verification checkpoint between them; verification only at the end of the sequence; verification prompt containing implementation content (code, tests, builds)
- Improvement tip: Insert a `## Verification Checkpoint N` prompt after every 2-3 implementation prompts. Each checkpoint runs `/verify` against the planning document and `/fix` for gaps. Verification prompts are self-contained (read rules card and planning document), do NOT count toward chain length limit, and use `## Verification Checkpoint N` heading (not `## Prompt N`).
- References: PRMT-SQ-04

### PRMT-QI-11: Execution Authority Quality

- Question: Do implementation prompts include "Execute without asking for confirmation" in Constraints?
- Evidence: scan each implementation prompt's Constraints section for the phrase
- Failure indicator: implementation prompt missing the execution authority constraint
- Improvement tip: add "Execute without asking for confirmation" to Constraints (PRMT-EX-03)
- References: PRMT-EX-03

### PRMT-QI-12: Timestamp Source Quality

- Question: Do Document History timestamps use request metadata, not extrapolated times?
- Evidence: check that Document History timestamps in files modified by the prompt match the timestamp from the prompt's request metadata
- Failure indicator: Document History timestamp is ahead of or behind the prompt submission time, indicating the agent estimated the timestamp
- Improvement tip: add "Use the timestamp from this prompt's request metadata for the Document History entry" to the prompt (PRMT-CT-13)
- References: PRMT-CT-13

### PRMT-QI-13: Spec-Code Consistency Quality

- Question: Does the Verify section check spec-code consistency when the prompt changes code with an associated spec?
- Evidence: check that the Verify section of prompts modifying code with an associated spec names the spec file and the clauses affected by the code change
- Failure indicator: prompt changes code but Verify section does not mention the spec file; spec drifts without detection
- Improvement tip: add spec-code consistency check to Verify section: "Check `_SPEC_[Name].md` section [N] still matches the code change. Update spec if drifted." (PRMT-HS-10)
- References: PRMT-HS-10
