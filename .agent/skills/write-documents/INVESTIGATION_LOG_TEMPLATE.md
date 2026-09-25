# Investigation Log Template

Template for creating investigation log files. Append-only. Never edit past entries except status updates.

**Source**: `specs/_SPEC_INVESTIGATE_WORKFLOW.md [INVESTIGATE-SP01]`

## Naming

`_LOG_[TOPIC].md` in session folder.

## ID Format

`I[NNN].[NNN]-type(topic_mnemonic)`

- NNN: investigation thread number (001-999), sequential
- type: state, action, finding, hypothesis, test, result, reasoning, note
- topic_mnemonic: lowercase, matches concept or module name

## References

- `@I[NNN].[NNN]` - Reference to another log entry
- `@file.md#LN-N` - External file reference

## Anchors

`### I[NNN].[NNN]-type(topic)` - grep-able headings

- `grep "^### I001\."` = all entries in thread 001
- `grep "^### I001\..*-finding"` = all findings in thread 001
- `grep "^### I\d+\.\d+-state"` = all STATE entries (handoff points)

## Bold Usage

Reserved for status/outcome values ONLY:

- STATE: **STARTING** **IN_PROGRESS** **BLOCKED** **STOPPED** **DONE**
- HYPOTHESIS: **OPEN** **CONFIRMED** **REFUTED**
- RESULT: **PASS** **FAIL** **INCONCLUSIVE**

Never bold field labels, descriptions, or other text within log entries. Document header fields (**Goal**:, **Started**:, **Sources**:) are exempt.

## Notation

Pipe notation for compact entries: `key=value | key=value | key=value`

## Entry Formats

### state

```
### I001.001-state(setup) [YYYY-MM-DD HH:MM]

**[STATUS]** | task=[current] | next=[what to do next] | open=[@I[NNN].[NNN] refs]

Paths used:
[NAME1]: C:\Path\to\folder
[NAME2]: C:\Path\to\other\folder
```

First STATE entry MUST include path lookup table. Subsequent STATE entries omit if paths unchanged.

### action

```
### I001.002-action(topic) [YYYY-MM-DD HH:MM]

[What was done. Terse.] Result: [outcome or @I[NNN].[NNN]]
```

### finding

```
### I001.003-finding(topic) [YYYY-MM-DD HH:MM]

[1-3 sentences.]

Props: [NAME]\file.ext | key=value | key=value

Source: [NAME]\file.ext | [lines/part] | [position]
````
[verbatim content only - not for simple values]
````
```

Props and Source blocks are optional. Use Props for simple key=value properties. Use Source + quad-backtick for verbatim copied content only.

### hypothesis

```
### I001.004-hypothesis(topic) [YYYY-MM-DD HH:MM]

[Statement. Why: @I[NNN].[NNN].]
test=[how to verify] | **[OPEN|CONFIRMED|REFUTED]**
```

### test

```
### I001.005-test(topic) [YYYY-MM-DD HH:MM]

tests=@I[NNN].[NNN] | [Setup and execution.]
```

### result

```
### I001.006-result(topic) [YYYY-MM-DD HH:MM]

for=@I[NNN].[NNN] | **[PASS|FAIL|INCONCLUSIVE]** | [Interpretation.]
```

### reasoning

```
### I001.007-reasoning(topic) [YYYY-MM-DD HH:MM]

based=@I[NNN].[NNN], @I[NNN].[NNN] | [Chain connecting evidence to conclusion.]
```

### note

```
### I001.008-note(topic) [YYYY-MM-DD HH:MM]

[Observation or caveat.]
```

## Document Structure

```markdown
# Log: [TOPIC]

**Goal**: [Single sentence]
**Started**: YYYY-MM-DD HH:MM
**Sources**: [files/URLs/ZIPs]

## Premises

- [premise: what is known or given before investigation starts]
- [premise: constraints, context, or prior knowledge]

## Index

<!-- One line per entry. Update when appending. -->
<!-- I001.001-state(setup) - [one-line summary] -->

### I001.001-state(setup) [YYYY-MM-DD HH:MM]

**STARTING** | task=[current] | next=[what to do next] | open=none

Paths used:
[NAME1]: C:\Path\to\folder
[NAME2]: C:\Path\to\other\folder
```

## Index Maintenance

Update `## Index` section after each new entry. One line per entry as HTML comment:

```
<!-- I001.001-state(setup) - Starting comparison of two builds -->
<!-- I001.002-action(setup) - Listed contents, identified key files -->
```

Rebuild from file: `grep "^### I\d+\.\d+-" _LOG_[TOPIC].md`
