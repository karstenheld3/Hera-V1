# ASCII Art Example: State Machines

Demonstrates state machines, flowcharts, and decision trees using Unicode box-drawing characters.

## Context

State machines show states and transitions. Flowcharts show branching logic with one start. Decision trees show hierarchy without cycles. Use Tier 2 light box-drawing. Loops as labeled text arrows, not drawn lines crossing the diagram. Max 7 states or 6 decisions.

## Document

### State Machine

```
[STATE MACHINE - DOCUMENT REVIEW]

 (*)
  │  create
  v
┌─────────┐   submit    ┌──────────┐   approve   ┌───────────┐
│ Draft   │────────────>│ Review   │────────────>│ Published │
└─────────┘             └──────────┘             └───────────┘
  ^                        │    │                      │
  │       reject           │    │ request changes      │ archive
  └────────────────────────┘    v                      v
                          ┌──────────┐            ┌───────────┐
                          │ Changes  │            │ Archived  │
                          └──────────┘            └───────────┘
                                │  resubmit           (final)
                                └─────────> Review

Legend: (*) = initial   (final) = terminal   arrow label = event
```

### Flowchart

```
[FLOWCHART - RETRY POLICY]

        ┌───────────┐
        │ Call API  │
        └─────┬─────┘
              │
              v
        / Succeeded? \──── Yes ────>  ┌─────────┐
        \            /                │ Return  │
         ─────┬──────                 └─────────┘
              │ No
              v
        / Attempts < 3? \── No ────>  ┌─────────┐
        \               /             │ Fail    │
         ──────┬────────              └─────────┘
               │ Yes
               v
        ┌──────────────┐
        │ Wait 2^n s   │
        └──────┬───────┘
               │
               └────────────> back to "Call API"

Legend: / \ = decision   Yes/No = branch   2^n = exponential backoff
```

### Decision Tree (Compact Form)

```
Call API
├─> Succeeded?  Yes -> Return
└─> No
    ├─> Attempts < 3?  No -> Fail
    └─> Yes -> Wait 2^n s -> back to Call API
```

### Event Flow Tree

```
[EVENT FLOW - USER CLICKS "Pause"]

User clicks [Pause]
├─> controlJob(jobId, "pause")
│   └─> fetch("/jobs/{id}/control?action=pause")
│       ├─> on success
│       │   └─> updateJob(jobId, { state: "paused" })
│       │       └─> renderJobRow(jobId)       # button becomes [Resume]
│       └─> on error
│           └─> showToast("Pause failed", "error")
└─> logAction("pause", jobId)
```

## Key Decisions

- State machine: one box per state, one label per transition, initial state marked with `(*)`
- Flowchart: main path vertical, exceptions branch right, loops as labeled text arrows
- Decision tree compact form uses `├─>` and `└─>` for indentation-based branching
- Event flow tree: `#` comment for side effects the reader cannot infer from the call name
- All diagrams use Tier 2 light (`┌ ─ ┐ │ └ ┘ ├ ┤ ┬ ┴ ┼`) per `core-conventions.md`
