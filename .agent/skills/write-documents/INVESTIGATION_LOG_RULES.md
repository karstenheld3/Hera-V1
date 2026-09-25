# Investigation Log Rules

Verification rules for investigation log files. Apply via `/verify` when log file is in scope.

**Source**: `specs/_SPEC_INVESTIGATE_WORKFLOW.md [INVESTIGATE-SP01]`

## Rule Index

Structure (ST)
- IL-ST-01: Log file naming follows `_LOG_[TOPIC].md` pattern
- IL-ST-02: Header contains Goal, Started, Sources fields
- IL-ST-03: Premises section exists with at least one premise
- IL-ST-04: Index section exists and is current
- IL-ST-05: First entry is a state entry with STARTING status

Entry Format (EF)
- IL-EF-01: Entry IDs follow I[NNN].[NNN]-type(topic) format
- IL-EF-02: Entry types are one of: state, action, finding, hypothesis, test, result, reasoning, note
- IL-EF-03: Entries have timestamp in `[YYYY-MM-DD HH:MM]` format
- IL-EF-04: Entries are append-only (no editing past entries except status updates)

Content (CT)
- IL-CT-01: Bold used only for status/outcome values
- IL-CT-02: State entries include task, next, and open fields
- IL-CT-03: First state entry includes path lookup table
- IL-CT-04: Hypothesis entries include test plan and status
- IL-CT-05: Result entries reference the hypothesis they test
- IL-CT-06: Reasoning entries list supporting evidence references

Index (IX)
- IL-IX-01: Every entry has a corresponding Index line
- IL-IX-02: Index lines are HTML comments with one-line summary
- IL-IX-03: Index is rebuildable via grep on entry headings

Hypothesis Lifecycle (HL)
- IL-HL-01: Every hypothesis has OPEN status initially
- IL-HL-02: Hypothesis status updated to CONFIRMED or REFUTED after test
- IL-HL-03: Confirmed/refuted hypotheses reference supporting evidence

## Structure Rules

### IL-ST-01: Log file naming

**BAD**: `_INVESTIGATION_LOG.md`, `investigation_log.md`, `LOG.md`
**GOOD**: `_LOG_CRAWLER.md`, `_LOG_DEVIN_PATCH.md`

### IL-ST-02: Header fields

**BAD**: Missing Started field or Sources field
**GOOD**: `**Goal**: Identify config changes between version A and B` / `**Started**: 2026-09-09 18:25` / `**Sources**: build-a.zip, build-b.zip`

### IL-ST-03: Premises section

**BAD**: No Premises section, or section with only one word
**GOOD**: At least one premise line with context

### IL-ST-04: Index section

**BAD**: Index empty or missing entries
**GOOD**: Every entry has a corresponding `<!-- I001.001-state(setup) - summary -->` line

### IL-ST-05: First entry is state

**BAD**: First entry is `action` or `finding`
**GOOD**: First entry is `### I001.001-state(setup) [YYYY-MM-DD HH:MM]` with **STARTING** status

## Entry Format Rules

### IL-EF-01: Entry ID format

**BAD**: `### Entry 1`, `### Finding 1`, `### I1.1-state`
**GOOD**: `### I001.001-state(setup)`, `### I002.004-finding(protobuf)`

### IL-EF-02: Valid entry types

**BAD**: `I001.001-conclusion(setup)`, `I001.001-observation(setup)`
**GOOD**: `I001.001-state(setup)`, `I001.002-action(setup)`, `I001.003-finding(setup)`

### IL-EF-03: Timestamp format

**BAD**: `[09/09/2026 6:25 PM]`, `[2026-9-9 18:25]`
**GOOD**: `[2026-09-09 18:25]`

### IL-EF-04: Append-only

**BAD**: Editing a past finding entry to add new information
**GOOD**: Appending a new entry with updated information, referencing the old entry

## Content Rules

### IL-CT-01: Bold for status only

**BAD**: `**Important**: The file size grew by 120KB` or `**Finding**: extension.js changed`
**GOOD**: `**STARTING** | task=compare builds` or `**CONFIRMED**` or `**PASS**`

### IL-CT-02: State entry fields

**BAD**: `**STOPPED**` with no task, next, or open fields
**GOOD**: `**STOPPED** | task=Reading diff output | next=Analyze protobuf types | open=@I001.004`

### IL-CT-03: Path lookup table

**BAD**: First state entry with no Paths section, paths hardcoded throughout log
**GOOD**: First state entry defines `[v38]: C:\path\to\v38`, subsequent entries use `[v38]\file.ext`

### IL-CT-04: Hypothesis completeness

**BAD**: `3.9 adds multimodal support.` (no test plan, no status)
**GOOD**: `3.9 adds multimodal support. Why: @I001.003. test=Search for DocumentData usage | **OPEN**`

### IL-CT-05: Result references hypothesis

**BAD**: `for=multimodal hypothesis | **CONFIRMED**`
**GOOD**: `for=@I002.001 | **CONFIRMED** | DocumentData and VideoData found in 3.9 extension.js`

### IL-CT-06: Reasoning lists evidence

**BAD**: `The 120KB growth is from protobuf types.`
**GOOD**: `based=@I002.004, @I002.005, @I001.008 | 120KB growth explained by new protobuf types DocumentData and VideoData plus 3 new gRPC methods`

## Index Rules

### IL-IX-01: Complete index

**BAD**: 10 entries in log body, 7 lines in Index
**GOOD**: Every entry has exactly one Index line

### IL-IX-02: Index line format

**BAD**: `I001.001 - Starting comparison`
**GOOD**: `<!-- I001.001-state(setup) - Starting comparison of two builds -->`

### IL-IX-03: Rebuildability

Verify by running: `grep "^### I\d+\.\d+-" _LOG_[TOPIC].md`
Count must match Index line count.

## Hypothesis Lifecycle Rules

### IL-HL-01: Initial OPEN status

**BAD**: Hypothesis created with `**CONFIRMED**` status (no test yet)
**GOOD**: Hypothesis created with `**OPEN**` status, updated after test

### IL-HL-02: Status update after test

**BAD**: Hypothesis remains OPEN after a result entry confirms/refutes it
**GOOD**: Hypothesis status updated to CONFIRMED or REFUTED, referencing the result entry

### IL-HL-03: Evidence reference in status update

**BAD**: `**CONFIRMED**` with no reference
**GOOD**: `**CONFIRMED** (@I002.012)` referencing the confirming result or reasoning entry
