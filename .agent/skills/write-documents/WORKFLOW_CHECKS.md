# Workflow Writing Checks

Process discipline and quality improvement checks for workflow creation. Consumed by `/drift-detect` (PD items) and `/improve` (QI items). Working agent must NOT read this file during workflow creation.

**Evidence sources:** conversation logs, git history, file timestamps, workflow file content, cross-references to other workflows

## Process Discipline (PD)

PD items verify the agent followed the correct process during workflow creation. Each item: action + evidence + failure indicator.

### WF-PD-01: Required Sections Present

- Action: Agent included all required sections (frontmatter, Goal/Why, MNF, Re-read, GLOBAL-RULES, CONTEXT-SPECIFIC, Phases, Quality Gate, Verification, Scope)
- Evidence: Each section heading present in workflow file
- Failure indicator: Missing section (e.g., no Quality Gate or no Scope boundary)
- References: IPPSWFLW-FR-01 through IPPSWFLW-FR-10

### WF-PD-02: Context Branching Implemented

- Action: Agent implemented context branching by document type or mode
- Evidence: CONTEXT-SPECIFIC section has H2 headings for each context
- Failure indicator: Single linear flow with no branching, or branches without H2 headings
- References: IPPSWFLW-FR-11, WF-BR-01

### WF-PD-03: No Context Match Fallback Present

- Action: Agent included "No Context Match" fallback with defined default action
- Evidence: "No Context Match" H2 section exists under CONTEXT-SPECIFIC
- Failure indicator: No fallback section, or fallback asks a question instead of defining an action
- References: IPPSWFLW-FR-12, WF-BR-02

### WF-PD-04: Single GRUC Type Consumed

- Action: Agent designed workflow to consume exactly one GRUC file type
- Evidence: Workflow references only one GRUC pattern (e.g., only `*_RULES.md` for `/verify`)
- Failure indicator: Workflow references both RULES and CHECKS, or both GUIDES and RULES
- References: IPPSWFLW-FR-15, IPPSWFLW-DD-01

### WF-PD-05: No Content Replication from GRUC Files

- Action: Agent did not copy rule descriptions or examples from GRUC files into the workflow
- Evidence: Workflow references GRUC files by filename and rule ID, not by copying content
- Failure indicator: Workflow contains a rule definition that also exists in a RULES file
- References: IPPSWFLW-FR-16, WF-RF-05

### WF-PD-06: CHECKS Not Referenced in Agent Steps

- Action: Agent did not reference `*_CHECKS.md` files in steps the working agent executes
- Evidence: CHECKS files referenced only in `/drift-detect` or `/improve` workflow contexts
- Failure indicator: A workflow step says "read SKILL_CHECKS.md" during execution
- References: IPPSWFLW-FR-18, IPPSSKLS-IG-02

### WF-PD-07: Phase and Step Enumeration Correct

- Action: Phases and steps start at 1 with no gaps, sub-numbering is numeric only
- Evidence: Phase/step numbers are sequential: 1, 2, 3 (not 0, 2, 4)
- Failure indicator: Phase 0 used for pre-flight, or alphabetic sub-numbering (1a, 1b)
- References: IPPSWFLW-FR-07, WF-ST-07

### WF-PD-08: References Use Correct Format

- Action: Workflow references use inline code `/name`, skill references use `@skills:` format
- Evidence: No bare names like "verify workflow" or "write-documents skill"
- Failure indicator: Workflow says "run the verify workflow" instead of "run `/verify`"
- References: IPPSWFLW-FR-19, IPPSWFLW-FR-20, WF-RF-01, WF-RF-02

### WF-PD-09: No Hardcoded Paths

- Action: Agent used standard placeholders instead of hardcoded paths
- Evidence: Paths use `[SESSION_FOLDER]`, `[AGENT_FOLDER]`, etc.
- Failure indicator: Workflow contains `E:\Dev\IPPS\...` or `/home/user/...`
- References: IPPSWFLW-FR-21, WF-RF-03

### WF-PD-10: Acronyms Expanded on First Use

- Action: Agent wrote out acronyms on first usage in the workflow
- Evidence: First occurrence of each acronym has full form
- Failure indicator: "Check MNF items" without "MUST-NOT-FORGET (MNF)" on first use
- References: IPPSWFLW-FR-04, WF-CT-02

### WF-PD-11: Gate Checks Use Checkbox Format

- Action: Phase transitions use checkbox format with Pass/Fail actions
- Evidence: Gate Check sections have `- [ ]` items and "Pass: ... | Fail: ..." line
- Failure indicator: Gate check is prose ("Before moving on, ensure all steps are done")
- References: IPPSWFLW-FR-13, WF-BR-03

### WF-PD-12: Trigger Section Present

- Action: Agent included Trigger section with invocation patterns
- Evidence: Trigger section lists `/name [args]` patterns
- Failure indicator: No Trigger section, or section says "when user wants to..." instead of listing patterns
- References: IPPSWFLW-FR-14, WF-BR-04

## Quality Improvement (QI)

QI items are judgment-based improvement tips. Not binary pass/fail. Each item: quality question + improvement tip.

### WF-QI-01: Scope Boundary Clarity

- Question: Is the scope boundary one line that clearly separates this workflow from adjacent ones?
- Improvement tip: If the scope line is vague ("finds issues"), make it specific ("Logic flaws only. Use `/verify` for conventions."). The scope boundary must prevent overlap.

### WF-QI-02: MNF Item Impact

- Question: Are MUST-NOT-FORGET items the highest-impact mistakes for this workflow, not just generic best practices?
- Improvement tip: Remove items that apply to all workflows ("read the rules"). Keep items specific to this workflow's failure modes ("never modify original document" for `/fact-check`).

### WF-QI-03: Context Branch Granularity

- Question: Are context branches at the right granularity - not too many (overhead) or too few (under-tailored)?
- Improvement tip: If branches share 80%+ of steps, merge them. If one branch has 50+ unique steps, split it. Target 3-5 branches per workflow.

### WF-QI-04: Phase Flow Clarity

- Question: Do phases flow logically with clear inputs and outputs per phase?
- Improvement tip: Each phase should state what it receives and what it produces. If a phase has no clear output, it is probably doing too little or too much.

### WF-QI-05: Quality Gate Completeness

- Question: Does the Quality Gate catch the most common failure modes for this workflow?
- Improvement tip: Review past FAILS.md entries for this workflow type. Add gate items for each recurring failure. Remove gate items that have never caught a real issue.

### WF-QI-06: Autonomous Execution Balance

- Question: Does the workflow pause only for genuinely destructive or ambiguous actions?
- Improvement tip: Remove confirmation gates for non-destructive actions. Add confirmation gates for actions that could corrupt data, send external messages, or delete files.

### WF-QI-07: Output Format Specificity

- Question: Is the output format specific enough that the agent knows exactly what to produce?
- Improvement tip: Show a concrete example of the output structure. If the format is "list of findings", show one finding inline. Vague format leads to inconsistent output.

### WF-QI-08: Cross-Workflow Overlap

- Question: Does this workflow overlap with any adjacent workflow?
- Improvement tip: Check if another workflow already performs any of the steps. If so, remove the overlap and reference the other workflow instead. Each step should belong to exactly one workflow.
