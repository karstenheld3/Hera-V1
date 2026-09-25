# Investigation Log Guides

Strategic guidance for writing investigation log entries. Read BEFORE writing log entries.

**Source**: `specs/_SPEC_INVESTIGATE_WORKFLOW.md [INVESTIGATE-SP01]`

## When to Write Each Entry Type

1. Write `state` at investigation start, phase boundaries, and investigation end
2. Write `action` after performing a concrete operation (extraction, search, comparison)
3. Write `finding` after discovering a fact, delta, or pattern
4. Write `hypothesis` when conjecturing about cause or structure (before testing)
5. Write `test` when executing verification of a hypothesis
6. Write `result` after a test completes (immediately after `test` entry)
7. Write `reasoning` when connecting multiple findings into a conclusion
8. Write `note` for observations, caveats, or context that do not fit other types

## How to Formulate Premises

1. List all given facts from the user prompt or session context
2. List constraints (file sizes, formats, access limitations)
3. List prior knowledge from documentation or previous sessions
4. List assumptions that are unverified but assumed true for the investigation
5. Each premise is one line, prefixed with context source

## How to Write Hypotheses

1. State the hypothesis as a declarative sentence
2. Reference supporting evidence: `Why: @I[NNN].[NNN]`
3. Define how to verify: `test=[verification method]`
4. Set initial status: `**OPEN**`
5. Update status to `**CONFIRMED**` or `**REFUTED**` after test result
6. Reference confirming/refuting evidence in status update

## How to Write State Entries for Handover

1. Use at phase boundaries or investigation pauses
2. Set status: **DONE** (phase complete), **STOPPED** (paused), **BLOCKED** (cannot proceed)
3. `task=` - what was accomplished in this phase
4. `next=` - what the next agent should do first
5. `open=` - references to unresolved hypotheses (@I[NNN].[NNN])
6. Include path lookup table in first STATE entry only

## How to Use Props vs Source

1. Use `Props:` for simple key=value pairs (sizes, counts, identifier lists)
2. Use `Source:` + quad-backtick for verbatim copied content (code snippets, config blocks)
3. Never use quad-backtick for simple values - use Props instead
4. Source block format: `Source: [NAME]\file.ext | [lines/part] | [position]`

## How to Reference Other Entries

1. Use `@I[NNN].[NNN]` to reference another log entry
2. In `reasoning` entries, list all supporting evidence: `based=@I001.003, @I002.005`
3. In `result` entries, reference the hypothesis: `for=@I001.004`
4. In `hypothesis` entries, reference supporting evidence: `Why: @I001.003`

## Thread Management

1. Start new thread (I002.xxx) when investigation shifts to a different topic area
2. Thread number increments when the investigation focus changes, not per phase
3. All entries within a thread share the same topic_mnemonic
4. Cross-thread references are valid: `@I001.003` in an I002 entry

## Companion Files

- `INVESTIGATION_LOG_TEMPLATE.md` - Entry format and document structure
- `INVESTIGATION_LOG_RULES.md` - Verification rules for log compliance
