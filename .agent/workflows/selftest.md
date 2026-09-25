---
description: Run Hera selftest - environment, configuration, prompt system, and model health checks
---

# Selftest Workflow

Run the built-in `hera selftest` subcommand and report its results. The subcommand is deterministic: run it and relay the output. Never improvise model tests.

## MUST-NOT-FORGET

- Live categories (04, 05, 06, 08) cost real API tokens. State the estimated cost BEFORE running them.
- Offline categories (01, 02, 03, 07, 09) are free.
- Never print API key material.

## Step 1: Show the Menu

Run `run_command` with `hera selftest --menu` from the workspace root. The menu lists every category with its code, name, and cost estimate.

## Step 2: Ask Which Categories to Run

- `/selftest` (no arguments) -> show the menu output, then call `ask_user_question` with the category choices (single codes, `offline`, `live`, `all`). Wait for the answer.
- `/selftest <codes|all|offline|live> [options]` -> pass the user's words directly as subcommand arguments. Category names also map: "models" -> `04 05 06`, "environment" -> `01`.

## Step 3: Cost Gate for Live Categories

If the selection includes any of 04, 05, 06, 08 (or `live`, `all`):
- State the estimated cost from the menu (example: "This runs live model tests, estimated cost ~$0.35 total.")
- Append `--budget 5.00` unless the user provided a budget.

## Step 4: Run

```
hera selftest <codes> [--provider <id>] [--model <id>] [--budget <usd>] [--timeout <secs>]
```

Run blocking from the workspace root. Progress prints per category; `results.json` is written to the data dir under `selftest/<timestamp>/`.

## Step 5: Report

Summarize for the user:
- Pass/fail/skip counts per category and total
- Total cost
- Every FAIL with its error message
- Path to `results.json`

Exit codes: 0 = all pass/skip, 1 = failures, 2 = invalid arguments, 3 = environment problem.
