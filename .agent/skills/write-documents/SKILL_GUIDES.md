# Skill Writing Guide

Step-by-step guide for creating well-structured agent skills.

## 1. Research First

Before writing any skill:

1. Understand the technology - how does it actually work?
2. Verify compatibility - does it work with the target agent (Devin, Claude Code, Codex)?
3. Identify dependencies - what must be installed? What versions?
4. Find known issues - check GitHub issues, forums, community reports
5. Test manually first - run commands yourself before documenting them

Document research in an INFO document or directly in SKILL.md.

## 2. Determine Skill Type

Classify before writing:

- **Instructional** - Multi-step procedures, decision logic, gotchas (e.g., `ms-playwright-mcp`)
- **Resource/lookup** - URL collections, reference lists (e.g., `travel-info`)
- **Setup-heavy** - Tool installation with system modifications (e.g., `computer-use-mcp`)

This determines format density:
- Instructional → standard format per `SKILL_TEMPLATE.md`
- Resource/lookup → compact format (one line per resource, no bullets)
- Setup-heavy → verbose SETUP.md/UNINSTALL.md with verification steps

## 3. Write SKILL.md

Follow `SKILL_TEMPLATE.md` structure. Key decisions:

**Frontmatter**: `name`, `description` (trigger conditions), `compatibility` (runtime needs)

**MUST-NOT-FORGET**: 3-10 items. Order by impact. Include:
- Most common mistake users make
- Data loss or security risks
- API gotchas (deprecated names, breaking changes)

**Intent Lookup**: Map user goals to procedures. Think "user wants to..." then arrow to action.

**Core Procedures**: Numbered steps with tool invocations. One procedure per common task.

**Technical Depth** (for tool/MCP skills): Include sufficient detail for the agent to use the skill without external docs:
- Architecture: how components connect (diagram preferred)
- Tool actions/API: all available actions with parameters
- Dependencies: what libraries/tools are used under the hood
- Platform specifics: OS-specific behavior (Windows, macOS, Linux)
- Capabilities and Limitations: what the skill enables and what it cannot do
- Sources: links to official docs, repos, research

Without sufficient technical detail, the agent cannot know which actions are available, anticipate limitations, or troubleshoot failures.

**Gotchas**: Non-obvious behavior. Format: `**Short label** - explanation and fix`

## 4. Token Optimization

Skill files are consumed by LLMs. Every token costs context window space.

**Remove** (visual-only, no LLM benefit):
- `**Bold**` markup in LLM-consumed reference files
- Verbose prefixes (`- **URL:** `, `- **Best for:** `) where compact format works
- Redundant prose restating headings
- Filler phrases: "This section covers", "The following resources"

**Keep** (improves LLM comprehension):
- `#` and `##` headers (structural parsing boundaries)
- Keywords/trigger lines (how the LLM finds the right file)
- Parenthetical notes with critical context
- All URLs, parameters, and technical detail
- Concrete examples

**Review metric**: "If I remove this token, does the LLM lose information?" If no, remove it.

Exception: SETUP.md and UNINSTALL.md may use richer formatting because they guide human users through system changes.

## 5. Write SETUP.md (If Needed)

Only if skill requires installation or system modification.

### 5.1 Pre-Installation Verification

Test WITHOUT modifying the system first:

```markdown
## Pre-Installation Verification

Complete ALL steps before modifying your system.

## 1. Verify [Prerequisite]
[commands]
Expected: [what user should see]

## 2. Test [Core Functionality]
[commands that test WITHOUT modifying system]
Expected: [what success looks like]

## Pre-Installation Checklist
- [ ] Prerequisite 1 verified
- [ ] Core functionality tested
- [ ] System state checked

**If all checks pass, proceed to installation.**
```

### 5.2 Installation

1. Backup existing configuration
2. Make minimal changes
3. Provide rollback instructions inline
4. Show expected results after each step

### 5.3 MCP Config Modification Pattern (per agent)

MCP server registration differs per agent - branch by target agent:

- Devin: `~/.codeium/windsurf/mcp_config.json` (legacy Windsurf path, verify current location on new Devin versions)
- Claude Code: `claude mcp add <name> -- npx package-name` (CLI-managed; or `.mcp.json` at project root for project scope)
- Codex: `~/.codex/config.toml` under `[mcp_servers.<name>]`

For JSON-config agents (Devin), use this PowerShell pattern:

```powershell
$configPath = "$env:USERPROFILE\.codeium\windsurf\mcp_config.json"

$targetServer = @{
    command = "npx"
    args = @("package-name")
}

# Read existing config
if (Test-Path $configPath) {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable
} else {
    $config = @{ mcpServers = @{} }
}

# Convert PSCustomObject to Hashtable if needed
if ($config.mcpServers -isnot [System.Collections.Hashtable]) {
    $serversHash = @{}
    $config.mcpServers.PSObject.Properties | ForEach-Object { $serversHash[$_.Name] = $_.Value }
    $config.mcpServers = $serversHash
}

# Idempotent check
if ($config.mcpServers.ContainsKey("server-name")) {
    $currentJson = $config.mcpServers["server-name"] | ConvertTo-Json -Compress
    $targetJson = $targetServer | ConvertTo-Json -Compress
    if ($currentJson -eq $targetJson) {
        Write-Host "Already configured" -ForegroundColor Green
        return
    }
}

# Backup before modifying
$backupPath = "$configPath._backup_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
Copy-Item $configPath $backupPath -ErrorAction SilentlyContinue

# Add/update server
$config.mcpServers["server-name"] = $targetServer
$config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
```

Requirements: idempotent, backup first, handle PSCustomObject, compare before write.

### 5.4 Post-Installation Verification

1. Verify installation succeeded
2. Test actual functionality
3. Document expected behavior
4. Provide troubleshooting for common failures

## 6. Write UNINSTALL.md (Required If SETUP.md Exists)

### 6.1 Pre-Uninstall Verification

```markdown
## Pre-Uninstall Verification

## 1. Check Current Installation
[commands to show what's installed]
Expected: [what indicates it's installed]

## 2. Check Dependencies
[commands to identify what depends on this]
If dependencies found: [what to do]

## Pre-Uninstall Checklist
- [ ] Current installation verified
- [ ] Dependencies checked
- [ ] Backup created (if needed)

**If all checks pass, proceed to uninstall.**
```

### 6.2 Uninstall

1. Remove in reverse order of installation
2. Show what each step removes
3. Verify removal after each step

### 6.3 Post-Uninstall Verification

1. Confirm all components removed
2. Verify system returned to clean state
3. Note any manual cleanup needed

## 7. File Layout

Apply `SKILL_RULES.md` SK-FL-* rules:

```
my-skill/
  SKILL.md                       # Required entry point
  SETUP.md                       # Standard name (unprefixed)
  UNINSTALL.md                   # Standard name (unprefixed)
  MYSKILL_REFERENCE.md           # Skill-specific (prefixed)
  myskill_config_examples.json   # Data files (lowercase)
  deploy_template.bat            # Script template (lowercase _template suffix)
  deploy_template.ps1            # Script template (lowercase _template suffix)
  CONVERSATION_TEMPLATE.md       # Document template (uppercase _TEMPLATE suffix)
```

### 7.1 Template Naming (SK-FL-07)

Files that serve as templates (copied and adapted per project) MUST use a `_TEMPLATE` or `_template` suffix:

- **Document templates**: `_TEMPLATE.md` (uppercase, per document conventions)
- **Script/code templates**: `_template.ext` (lowercase, per code conventions)

This prevents confusion between operational files and templates that require adaptation. Without the suffix, a user or agent may attempt to run a template directly (missing placeholder substitution).

## 8. GRUC File Set

Every skill needs a GRUC (Guides, Rules, Checks) file set. The set depends on skill type and complexity. See `specs/_SPEC_IPPS_SKILLS.md [IPPSSKLS-SP01]` for the full specification.

### 8.1 Required: SKILL_RULES.md

Always required. Defines output standards for artifacts produced using this skill.

1. Write Rule Index at top with all rule IDs and one-line descriptions
2. Write BAD/GOOD example pairs for every non-trivial rule
3. Use consistent rule ID format: `[PREFIX]-[CATEGORY]-[NN]`
4. Make rules testable (answerable yes/no for any given artifact)
5. Do not include Document History section

Reference: `SKILL_RULES.md` (SK-* IDs), `IPPSSKLS-FR-02`

### 8.2 Conditional: SKILL_GUIDES.md

Required when skill involves complex decision-making, multi-step strategies, or trade-offs.

**Trigger question**: Does the agent need to make decisions about HOW to approach the task?

If yes:
1. Write numbered decision steps (not free prose)
2. Make each section actionable (tell agent what to DO, not what to know)
3. Link to EXAMPLE files if they exist
4. Reference companion SKILL_RULES.md for verification
5. Do not include verification checklists (those belong in RULES)

Reference: `IPPSSKLS-FR-04`, `IPPSSKLS-DD-04`

### 8.3 Conditional: SKILL_CHECKS.md

Required when skill produces quality-critical output or when process discipline matters.

**Trigger question**: Does it matter HOW the agent arrived at the output, or only that the output is correct?

If process matters:
1. Write Process Discipline (PD) items: action + evidence + failure indicator
2. Write Quality Improvement (QI) items: quality question + improvement tip
3. PD items reference rule IDs from SKILL_RULES.md they verify
4. QI items are judgment-based, not binary pass/fail
5. Order items by execution sequence

The working agent must NOT see this file during execution. CHECKS are consumed by `/drift-detect` (PD) and `/improve` (QI) after execution.

Reference: `IPPSSKLS-FR-05`, `IPPSSKLS-DD-05`, `SKILL_CHECKS.md`

### 8.4 Optional: EXAMPLE Files

Show larger GOOD examples that go beyond simple BAD/GOOD pairs in RULES.

1. Name files: `[TOPIC]_EXAMPLE_[NN]-[ExampleName].md`
2. Show complete or substantial documents demonstrating the GOOD approach
3. Make each example use-case-specific (solves a specific problem type)
4. Document key decisions and rationale
5. Do not include BAD examples (BAD/GOOD pairs stay in RULES)
6. Link from SKILL_GUIDES.md, not from SKILL.md or SKILL_RULES.md

Reference: `IPPSSKLS-FR-06`

### 8.5 Optional: SKILL_TEMPLATE.md

Provides skeleton structure for documents created with this skill. Agents copy the template, fill in placeholders, and strip XML comments.

**Trigger question**: Does this skill produce a specific document type that benefits from a skeleton?

If yes:
1. Use `_TEMPLATE.md` suffix (SK-FL-07)
2. Template IS the document - every line is template content or XML comment
3. Placeholders use bracket notation `[BRACKETS]`
4. Complex rules in companion `*_RULES.md` or `*_GUIDES.md`, not inline
5. Consumed by `/verify` alongside SKILL_RULES.md for template adherence

Reference: `GRUC-FR-01`, `GRUC-FR-19`, `IPPSSKLS-FR-08`

### 8.6 GRUC File Discovery

SKILL.md References section must list all GRUC companion files so consumers know what exists:

```
**References** (loaded on demand):
- SKILL_RULES.md - Output standards for [domain] documents
- SKILL_GUIDES.md - Process guidance for [domain] decisions
- SKILL_CHECKS.md - Process discipline and quality checks
- SKILL_TEMPLATE.md - Template for [document type]
```

### 8.7 GRUC Separation Rules

- RULES define output standards. No process guidance.
- GUIDES define process strategy. No output standards.
- CHECKS define process audit and improvement. No output standards or process guidance.
- TEMPLATE files contain only structural skeleton and placeholders. No rules, no guidance, no audit items.
- No content replication between GRUC files. Reference by rule ID.
- CHECKS invisible to working agent during execution (gaming prevention).

## 9. Review Checklist

Before publishing:

- [ ] Research documented (INFO or in SKILL.md)
- [ ] SKILL.md has MUST-NOT-FORGET section
- [ ] SKILL.md self-contained for common use cases
- [ ] File layout follows SK-FL-* rules
- [ ] If SETUP.md exists: pre-installation verification present
- [ ] If SETUP.md exists: UNINSTALL.md also exists
- [ ] All code snippets tested manually
- [ ] Expected output documented for each step
- [ ] Token optimization applied (no visual-only formatting in LLM-consumed files)
- [ ] Template files use `_TEMPLATE`/`_template` suffix (SK-FL-07)
- [ ] References link to primary sources
- [ ] SKILL_RULES.md exists with Rule Index and BAD/GOOD pairs
- [ ] SKILL.md References section lists all GRUC companion files
- [ ] If skill has complex decisions: SKILL_GUIDES.md exists with numbered decision steps
- [ ] If skill has quality-critical process: SKILL_CHECKS.md exists with PD + QI sections
- [ ] No content replication between GRUC files (reference by ID only)
- [ ] EXAMPLE files (if any) linked from SKILL_GUIDES.md, not from SKILL.md
- [ ] If skill has a template: SKILL_TEMPLATE.md exists with `_TEMPLATE` suffix
