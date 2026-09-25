# Workflow Writing Guide

Strategic guide for creating well-structured IPPS workflows. Read BEFORE writing a workflow. See `specs/_SPEC_IPPS_WORKFLOWS.md [IPPSWFLW-SP01]` for the full specification.

## 1. Determine Workflow Purpose

Before writing, answer:

1. What single task type does this workflow handle? (one sentence)
2. What document types or modes does it branch on?
3. Which GRUC file type does it consume? (RULES+TEMPLATE, GUIDES, CHECKS PD, or CHECKS QI)
4. What adjacent workflows already exist? (check for overlap)

If the workflow overlaps with an existing one, merge or split - do not create partial duplicates.

## 2. Design Context Branching

Identify the contexts the workflow must handle. Common branching dimensions:

- **By document type**: INFO, SPEC, IMPL, Code, TEST, Workflow/Skill
- **By mode**: SESSION-MODE, PROJECT-MODE
- **By artifact state**: SPEC exists, IMPL exists, neither exists

Decision steps:

1. List all contexts the workflow will encounter
2. For each context, identify what differs (steps, inputs, outputs)
3. If two contexts share 80%+ of steps, merge them with a conditional
4. Always add "No Context Match" as fallback - define a default action, never a question
5. Target 3-5 branches per workflow

## 3. Write Required Sections

Write sections in this order:

1. **Frontmatter**: `description` field, optional `auto_execution_mode`
2. **Goal and Why**: One line each, after title
3. **Required Skills**: List skills the workflow uses (`@skills:name` format)
4. **MUST-NOT-FORGET**: 3-10 items, ordered by impact, simple list
5. **Mandatory Re-read**: Branch by mode, list tracking documents
6. **GLOBAL-RULES**: Universal rules for all contexts, numbered
7. **CONTEXT-SPECIFIC**: H1 section, H2 per context, "No Context Match" fallback
8. **Phases**: Numbered from 1, no gaps, numeric sub-numbering only
9. **Quality Gate**: Checkbox format with Pass/Fail actions
10. **Verification**: Reference `/verify` with specific checks
11. **Scope**: One line, what workflow does NOT do

Reference: `WORKFLOW_RULES.md` (WF-* IDs) for all rules with BAD/GOOD examples.

## 4. Design GRUC Consumption

Each workflow consumes exactly one GRUC file type. Exception: `/verify` consumes both RULES and TEMPLATE (both are structural verification files). Determine which:

- **RULES + TEMPLATE** (`*_RULES.md` and `*_TEMPLATE.md`): Workflow checks output against structural standards and template adherence. Consumer: `/verify`
- **GUIDES** (`*_GUIDES.md`): Workflow reviews strategic approach and finds gaps. Consumer: `/critique`
- **CHECKS PD** (`*_CHECKS.md` PD items): Workflow audits process discipline after execution. Consumer: `/drift-detect`
- **CHECKS QI** (`*_CHECKS.md` QI items): Workflow applies quality improvements. Consumer: `/improve`

Rules for GRUC consumption:

1. Read only the designated GRUC file type - never read multiple types (exception: `/verify` reads RULES and TEMPLATE)
2. Never copy content from GRUC files - reference by file + rule ID
3. CHECKS files must not be referenced in steps the working agent executes
4. Discover GRUC files by scanning the skill folder in Required Skills

Reference: `GRUC-IG-01`, `IPPSSKLS-IG-01`, `IPPSWFLW-FR-15`, `IPPSWFLW-FR-16`

## 5. Write Phases and Steps

### 5.1 Phase Structure

Each phase has:
- Clear input (what it receives from previous phase)
- Numbered steps (actionable, concise)
- Clear output (what it produces for next phase)
- Gate check at end (checkbox format, Pass/Fail actions)

### 5.2 Step Writing

- Numbered, starting at 1 within each phase
- Actionable: "Read SKILL.md" not "The SKILL.md should be read"
- Concise: one action per step, no multi-step steps
- Reference rules by ID: "Apply WF-ST-01" not "follow the structure rules"

### 5.3 Enumeration Rules

- Phases start at 1, no gaps (no Phase 0)
- Sub-numbering numeric only: `1.1`, `1.2` (not `1a`, `1b`)
- Same for Steps, Stages, Parts

Reference: `WORKFLOW_RULES.md` WF-ST-07

## 6. Write Gate Checks and Quality Gate

### 6.1 Phase Gate Checks

At each phase transition:

```
## Gate Check: [FROM]→[TO]

- [ ] All steps from Phase N completed
- [ ] Output matches expected format
- [ ] No errors recorded

Pass: Proceed to Phase N+1 | Fail: Continue Phase N
```

### 6.2 Final Quality Gate

Before workflow completion:

```
## Quality Gate

- [ ] All phases completed
- [ ] Output produced in correct location
- [ ] Stuck detection not triggered
- [ ] `/verify` passed
```

## 7. Write Autonomous Execution Rules

### 7.1 Confirmation Gates

Only pause for:
- **Destructive**: renaming files, deleting content, overwriting user data, sending emails
- **Ambiguous**: multiple candidates, no way to determine correct one

Do NOT pause for:
- Creating new files
- Extracting data
- Reading context
- Populating templates
- Setting defaults

### 7.2 Stuck Detection

Define threshold and actions:

```
## Stuck Detection

If 3 consecutive attempts fail:
1. Document in PROBLEMS.md
2. Ask user for guidance
3. Either get guidance or defer and continue
```

### 7.3 Output Format

Show expected output structure inline:

```
## Output

`Executed: [item] | Result: OK/FAIL | Remaining: [N]`
```

## 8. GRUC File Set for Workflows

Workflows do not have their own GRUC files. Workflows consume GRUC files from skills. However, the `write-documents` skill provides:

- `WORKFLOW_RULES.md` - Rules for workflow document structure (consumed by `/verify`)
- `WORKFLOW_GUIDES.md` (this file) - Strategic guidance for writing workflows (consumed by `/critique`)
- `WORKFLOW_CHECKS.md` - Process discipline and quality checks for workflow creation (consumed by `/drift-detect` and `/improve`)
- `WORKFLOW_TEMPLATE.md` - Optional skeleton structure for new workflow documents (consumed by `/verify` alongside `WORKFLOW_RULES.md`)

When writing a new workflow, the agent reads this GUIDE before starting. After completion, `/verify` checks the workflow against `WORKFLOW_RULES.md` and `WORKFLOW_TEMPLATE.md` (if it exists), `/critique` reviews the approach against this GUIDE, and `/drift-detect` audits the process against `WORKFLOW_CHECKS.md` PD items.

If the workflow has a template, `/verify` checks instantiated workflows against both `WORKFLOW_RULES.md` and `WORKFLOW_TEMPLATE.md`.

## 9. Review Checklist

Before publishing:

- [ ] Frontmatter has `description` field
- [ ] Goal and Why present after title
- [ ] MUST-NOT-FORGET section (3-10 items, simple list)
- [ ] Mandatory Re-read section (branched by mode)
- [ ] GLOBAL-RULES section (numbered, actionable)
- [ ] CONTEXT-SPECIFIC with "No Context Match" fallback
- [ ] Phases numbered from 1 with no gaps
- [ ] Quality Gate with checkbox format
- [ ] Verification section referencing `/verify`
- [ ] Scope boundary (one line, what workflow does NOT do)
- [ ] Workflow consumes exactly one GRUC file type (exception: `/verify` reads RULES + TEMPLATE per `GRUC-IG-01`)
- [ ] No content replication from GRUC files
- [ ] References use `/name` for workflows, `@skills:name` for skills
- [ ] No hardcoded paths (uses standard placeholders)
- [ ] Acronyms expanded on first use
- [ ] Gate checks use checkbox format with Pass/Fail
- [ ] Trigger section with invocation patterns
