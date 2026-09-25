# Template Writing Checks

Process discipline and quality improvement checks for template creation. Consumed by `/drift-detect` (PD items) and `/improve` (QI items). Working agent must NOT read this file during template creation.

**Evidence sources:** conversation logs, git history, file timestamps, TEMPLATE_RULES.md content, instantiated output documents

## Process Discipline (PD)

PD items verify the agent followed the correct process during template creation. Each item: action + evidence + failure indicator.

### TMPL-PD-01: Template Is the Document Skeleton

- Action: Agent wrote the template as the document itself, not a meta-wrapper describing it
- Evidence: Template content is directly usable as output, not wrapped in code blocks with descriptive headings
- Failure indicator: Template has headings like "## Header Block" or "## Section Structure" describing sections instead of being sections
- References: TMPL-ST-01, TMPL-ST-03

### TMPL-PD-02: No Prose Between Sections

- Action: Agent did not write prose paragraphs between template sections
- Evidence: Sections contain only template content and XML comments
- Failure indicator: Explanatory paragraphs between sections that would be preserved in output
- References: TMPL-ST-02

### TMPL-PD-03: All Annotations Use XML Comments

- Action: Agent used XML comments for all annotations (removal instructions, conditional markers, inline rules)
- Evidence: No bracket markers `[conditional - ...]` or italic markers `*(text)*` in template
- Failure indicator: Annotations use bracket or italic format instead of `<!-- ... -->`
- References: TMPL-AN-01, TMPL-AN-03, TMPL-AN-04

### TMPL-PD-04: Conditional Sections Have Criteria and Rule Reference

- Action: Agent wrote conditional sections with insertion criteria and rule reference
- Evidence: Each conditional section has `<!-- Conditional: insert when [criteria]. Per [rule ID] -->`
- Failure indicator: Conditional section has no criteria or no rule reference
- References: TMPL-AN-02

### TMPL-PD-05: No Inline Teaching Examples

- Action: Agent did not embed BAD/GOOD comparisons as template content
- Evidence: BAD/GOOD examples wrapped in XML comments or moved to companion RULES file
- Failure indicator: Template has visible BAD/GOOD blocks that would appear in instantiated output
- References: TMPL-AN-05, TMPL-AN-06

### TMPL-PD-06: Complex Rules in Companion Files

- Action: Agent placed complex rules and decision logic in companion `*_RULES.md` or `*_GUIDES.md`, not in template
- Evidence: Template contains only skeleton and inline annotations; rules referenced by ID
- Failure indicator: Template contains multi-line rule explanations or decision trees
- References: TMPL-ST-06

### TMPL-PD-07: Placeholders Use Bracket Notation Consistently

- Action: Agent used bracket notation for values, IDs, and enumerated choices
- Evidence: All fill-in fields use `[BRACKETS]`; date patterns use format directly without brackets
- Failure indicator: Date placeholder is `[YYYY-MM-DD]` instead of `YYYY-MM-DD`
- References: TMPL-PH-01, TMPL-PH-02

### TMPL-PD-08: Doc ID and Header Fields Correct

- Action: Agent included Doc ID with Topic ID comment for per-task templates; omitted for non-per-task
- Evidence: Per-task templates have `**Doc ID**: [TOPIC]-[TYPE][NN]` with Topic ID XML comment; tracking logs and scaffolding do not
- Failure indicator: Per-task template missing Doc ID or Topic ID comment; non-per-task template has Doc ID
- References: TMPL-HD-01, TMPL-HD-02, TMPL-HD-03

### TMPL-PD-09: Document History in Per-Task Templates

- Action: Agent included Document History section in per-task templates
- Evidence: Per-task templates have `## Document History` with reverse chronological format
- Failure indicator: Per-task template missing Document History; non-per-task template has it unnecessarily
- References: TMPL-SN-01

### TMPL-PD-10: Full Example at End When Required

- Action: Agent included a full example in fenced code block when template has 3+ sections, conditional sections, or complex placeholders
- Evidence: Full example present with `<!-- EXAMPLE: -->` annotation at template end
- Failure indicator: Complex template has no full example, or example lacks annotation
- References: TMPL-ST-05

### TMPL-PD-11: Repeatable Items Show One Instance

- Action: Agent showed one instance of repeatable items, not multiple copies
- Evidence: One example entry with all fields; agent generates additional entries following pattern
- Failure indicator: Template has D-01, D-02, D-03 entries showing identical structure
- References: TMPL-ST-04

## Quality Improvement (QI)

QI items are judgment-based improvement tips. Not binary pass/fail. Each item: quality question + improvement tip.

### TMPL-QI-01: Annotation Clarity

- Question: Can the filling agent determine what goes in each section without external context?
- Improvement tip: Add inline XML comments where field purpose is ambiguous. The agent should never wonder "what goes here?" Test by reading only the template file.

### TMPL-QI-02: Placeholder Specificity

- Question: Are placeholders specific enough to guide filling, or generic enough to be reusable?
- Improvement tip: Replace `[value]` with `[Single sentence describing purpose]` or `[Minimal | Low | Medium | High]` to show expected format. Avoid overly specific placeholders that only fit one use case.

### TMPL-QI-03: Conditional Section Completeness

- Question: Are all conditional sections marked with criteria, or are some implicit?
- Improvement tip: Review each section and ask "is this always present?" If not, mark with `<!-- Conditional: insert when [criteria]. Per [rule ID] -->`. Derive candidates from exemplar analysis.

### TMPL-QI-04: Template Matches Real Documents

- Question: Does the template structure match what a correctly completed document actually looks like?
- Improvement tip: Compare template against 2-3 real instances of the document type. If real documents have sections not in the template, add them. If template has sections never used in practice, mark as conditional or remove.

### TMPL-QI-05: Companion File References

- Question: Does the template reference the correct companion RULES and GUIDES files for complex decisions?
- Improvement tip: Add `<!-- See [RULES_FILE] [RULE_ID] for [decision topic] -->` where the agent needs to make a choice. Keep the template clean; push complexity to companions.

### TMPL-QI-06: Exemplar Quality

- Question: If a full example is included, does it show a realistic, complete document - not a skeleton with placeholders?
- Improvement tip: Replace placeholder-filled examples with real completed documents. The example should resolve all ambiguities that instructions alone cannot. Use generic data per privacy rules.

### TMPL-QI-07: Template Category Alignment

- Question: Does the template correctly distinguish per-task (Doc ID, Timeline, Document History) from other templates (no Doc ID)?
- Improvement tip: Review against TEMPLATE_GUIDES.md section 3. If a tracking log or scaffolding template has per-task fields, remove them. If a per-task template lacks them, add them.
