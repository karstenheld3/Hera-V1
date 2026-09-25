---
description: Structured investigation with STRUT plan and append-only log
auto_execution_mode: 3
---

# Investigate Workflow

Structured investigation of a problem using a STRUT plan with phased approaches and an append-only investigation log for cross-session continuity.

**Goal**: Produce a STRUT plan defining investigation phases and an append-only log tracking findings, hypotheses, and state transitions

**Why**: Multi-session investigations need structured context handover. Without a log, each agent re-discovers what previous agents already found. Without a STRUT, investigation lacks direction and checkpoints.

Scope: Deep problem analysis requiring multi-phase investigation. Use `/research` for single-topic information gathering. Use `/fix` for known-cause bug fixes.

## Required Skills

- @skills:write-documents for INVESTIGATION_LOG_TEMPLATE, INVESTIGATION_GUIDES, INVESTIGATION_LOG_RULES, STRUT_TEMPLATE

## MUST-NOT-FORGET

- Create STRUT plan BEFORE starting investigation
- Create log file BEFORE executing Phase 1
- Log is append-only: never edit past entries except status updates
- After each phase: update log with STATE entry (final state + handover) AND update STRUT progress
- Log entry IDs must be grep-able: `I[NNN].[NNN]-type(topic)`
- Bold reserved for status/outcome values only in log entries
- Run `/verify` to validate log structure against INVESTIGATION_LOG_RULES

## Mandatory Re-read

**SESSION-MODE**:
- NOTES.md, PROBLEMS.md, PROGRESS.md, FAILS.md

**PROJECT-MODE**:
- !NOTES.md or NOTES.md, PROBLEMS.md, FAILS.md

## Output

```
__STRUT_[TOPIC].md          ← Investigation phase plan with log checkpoints
_LOG_[TOPIC].md             ← Append-only investigation log
```

# EXECUTION

## Phase 1: Setup

1. Read @skills:write-documents `INVESTIGATION_LOG_TEMPLATE.md` for log file format
2. Read @skills:write-documents `INVESTIGATION_GUIDES.md` for entry type guidance
3. Read @skills:write-documents `STRUT_TEMPLATE.md` for STRUT format

4. Formulate investigation goal in one sentence
5. Collect premises: list all known facts, given information, starting assumptions
6. Analyze problem nature: classify as CODE, CONFIGURATION, DESIGN, UNDERSTANDING, PROCESS, or BINARY
7. List known knowns: what is confirmed and verified
8. List known unknowns: what needs to be discovered or tested

9. Write STRUT plan (`__STRUT_[TOPIC].md`):
   1. Define phases where Phase 1 is the highest-priority investigation approach
   2. Each phase has Objectives, Strategy, Steps, Deliverables, Transitions
   3. Each phase MUST include mandatory log checkpoint steps:
      - First step: `[LOG](create or append: initial state)`
      - Last step: `[LOG](append: final state + handover)`
   4. Transitions reference Deliverables and log state entries
10. Create investigation log (`_LOG_[TOPIC].md`):
    1. Fill header: Goal, Started, Sources
    2. Fill Premises section from Step 5
    3. Create Index section (update on each new entry)
    4. Write first STATE entry: `I001.001-state(setup)` with **STARTING** status and path lookup table

## Phase 2: Investigate

1. Execute Phase 1 steps from STRUT plan
2. After each significant action or finding, append log entry:
   - `action` - what was done
   - `finding` - what was discovered
   - `hypothesis` - what was conjectured (with test plan and OPEN status)
   - `test` - how a hypothesis was tested
   - `result` - outcome of a test (PASS/FAIL/INCONCLUSIVE)
   - `reasoning` - chain connecting evidence to conclusion
   - `note` - observation or caveat
3. Update Index section after each new entry
4. Update hypothesis status when confirmed or refuted

## Phase 3: Phase Handover

After completing a STRUT phase:

1. Append final STATE entry to log:
   - Status: **DONE**, **STOPPED**, or **BLOCKED**
   - task: what was accomplished
   - next: what the next phase or action should be
   - open: references to unresolved hypotheses (@I[NNN].[NNN])
2. Update STRUT plan:
   - Check completed Deliverables
   - Check completed Objectives
   - Follow Transition rules
3. If investigation continues in next phase:
   - Log handover notes in final STATE entry
   - Next agent reads log Index, last STATE entry, and open hypotheses
4. If investigation complete:
   - Write summary in final STATE entry
   - Run `/verify` on log file

## Stuck Detection

If 3 consecutive hypothesis tests are INCONCLUSIVE:
1. Document in PROBLEMS.md
2. Re-read premises and known unknowns
3. Consider alternative investigation approach (new STRUT phase or revised strategy)

## Verification

Run `/verify` to check:
1. Log structure follows INVESTIGATION_LOG_RULES
2. STRUT plan follows STRUT_TEMPLATE
3. All hypotheses have resolved status (CONFIRMED or REFUTED) or are documented as open
4. Index matches actual entries
5. No past entries modified (append-only check)

## Quality Gate

- [ ] STRUT plan created with at least one phase
- [ ] STRUT phases include mandatory log checkpoint steps
- [ ] Log file created with Goal, Started, Sources, Premises, Index
- [ ] First STATE entry has path lookup table
- [ ] All entries have valid IDs (I[NNN].[NNN]-type(topic))
- [ ] Bold used only for status/outcome values
- [ ] Index updated after each new entry
- [ ] Final STATE entry has handover notes
- [ ] STRUT progress checkboxes updated
