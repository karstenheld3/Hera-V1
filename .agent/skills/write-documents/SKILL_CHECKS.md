# Skill Writing Checks

Process discipline and quality improvement checks for skill creation. Consumed by `/drift-detect` (PD items) and `/improve` (QI items). Working agent must NOT read this file during skill creation.

**Evidence sources:** conversation logs, git history, file timestamps, SKILL.md content, folder structure

## Process Discipline (PD)

PD items verify the agent followed the correct process during skill creation. Each item: action + evidence + failure indicator.

### SK-PD-01: Research Before Writing

- Action: Agent researched the technology before writing skill files
- Evidence: Research documented in INFO document or SKILL.md research section
- Failure indicator: SKILL.md describes a tool the agent never tested or verified
- References: SKILL_GUIDES.md section 1

### SK-PD-02: Skill Type Classification Before Writing

- Action: Agent classified skill as Instructional, Resource/lookup, or Setup-heavy before writing
- Evidence: Classification decision documented or inferable from SKILL.md structure
- Failure indicator: Skill format does not match type (e.g., Setup-heavy skill without SETUP.md)
- References: SKILL_GUIDES.md section 2, IPPSSKLS-DD-01

### SK-PD-03: GRUC File Set Created

- Action: Agent created the required GRUC files for the skill type
- Evidence: SKILL.md References section lists all companion GRUC files
- Failure indicator: SKILL.md has no References section or references are incomplete
- References: IPPSSKLS-FR-01, IPPSSKLS-FR-02, IPPSSKLS-FR-03

### SK-PD-04: RULES File Has Testable Rules

- Action: Agent wrote rules that are answerable yes/no for any given artifact
- Evidence: Each rule in SKILL_RULES.md can be checked against an actual file
- Failure indicator: Rule says "should be well-organized" (subjective, not testable)
- References: SKILL_RULES.md, IPPSSKLS-FR-02

### SK-PD-05: BAD/GOOD Pairs Present for Non-Trivial Rules

- Action: Agent provided BAD/GOOD example pairs for every non-trivial rule
- Evidence: Each rule in SKILL_RULES.md has at least one BAD and one GOOD example
- Failure indicator: Rule has no examples or only description without examples
- References: SKILL_RULES.md, AP-PR-08

### SK-PD-06: Conditional GRUC Files Created When Required

- Action: Agent created SKILL_GUIDES.md for skills with complex decisions, SKILL_CHECKS.md for quality-critical skills
- Evidence: Conditional files present when triggers are met
- Failure indicator: Skill with multi-step decision logic has no SKILL_GUIDES.md
- References: IPPSSKLS-FR-04, IPPSSKLS-FR-05, IPPSSKLS-DD-04, IPPSSKLS-DD-05

### SK-PD-07: SETUP.md and UNINSTALL.md Paired

- Action: If SETUP.md exists, UNINSTALL.md also exists
- Evidence: Both files present in skill folder
- Failure indicator: SETUP.md exists without UNINSTALL.md
- References: IPPSSKLS-FR-07, SK-ST-05, SK-ST-06, SK-ST-07

### SK-PD-08: No Content Replication Between GRUC Files

- Action: Agent did not copy content from RULES into GUIDES or CHECKS
- Evidence: Each GRUC file has unique content; cross-references use rule IDs
- Failure indicator: SKILL_GUIDES.md contains a rule definition also in SKILL_RULES.md
- References: IPPSSKLS-IG-03, WF-RF-05

### SK-PD-09: Template Files Use _TEMPLATE Suffix

- Action: Template files use `_TEMPLATE.md` (documents) or `_template.ext` (scripts) suffix
- Evidence: File names in skill folder follow convention
- Failure indicator: Template file exists without `_TEMPLATE` or `_template` suffix
- References: SK-FL-07, IPPSSKLS-FR-08

### SK-PD-10: Token Optimization Applied

- Action: Agent removed visual-only formatting from LLM-consumed reference files
- Evidence: No bold markup for emphasis, no filler phrases in RULES/GUIDES/CHECKS
- Failure indicator: `**Bold**` used for emphasis (not in BAD/GOOD labels) in GRUC files
- References: SKILL_GUIDES.md section 4, SK-CT-05

## Quality Improvement (QI)

QI items are judgment-based improvement tips. Not binary pass/fail. Each item: quality question + improvement tip.

### SK-QI-01: Skill Scope Appropriateness

- Question: Is the skill scope appropriate - not too broad (multiple unrelated tools) or too narrow (single function)?
- Improvement tip: If too broad, split into multiple skills. If too narrow, consider merging with a related skill. A skill should cover one tool or one coherent concept.

### SK-QI-02: Intent Lookup Completeness

- Question: Does the Intent Lookup cover all common user goals for this skill?
- Improvement tip: Map user goals to procedures. Think "user wants to..." for each entry. If users frequently ask for something not in Intent Lookup, add it.

### SK-QI-03: MUST-NOT-FORGET Impact Ordering

- Question: Are MUST-NOT-FORGET items ordered by impact (most common mistake first)?
- Improvement tip: Reorder so the first item is the one most likely to cause failure. Data loss and security risks rank above style issues.

### SK-QI-04: Example Quality

- Question: Do examples show realistic, professional scenarios - not trivial or artificial ones?
- Improvement tip: Replace placeholder examples with ones that demonstrate actual decision points. Add EXAMPLE files for complex use cases that need more than a BAD/GOOD pair.

### SK-QI-05: Cross-Reference Completeness

- Question: Does SKILL.md References section list all companion files?
- Improvement tip: Every file in the skill folder should appear in References with a one-line purpose. Missing references mean consumers do not know the file exists.

### SK-QI-06: Guide Actionability

- Question: If SKILL_GUIDES.md exists, does each section tell the agent what to DO (not what to know)?
- Improvement tip: Replace explanatory sections with actionable steps. A guide is coaching, not documentation. If a section has no action, move it to SKILL.md as context.

### SK-QI-07: Checks Evidence Quality

- Question: If SKILL_CHECKS.md exists, do PD items have concrete evidence sources?
- Improvement tip: Replace vague evidence ("agent followed process") with concrete evidence ("git history shows research commit before skill commit"). Evidence must be observable in artifacts.
