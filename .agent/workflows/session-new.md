---
description: Initialize a new development session
auto_execution_mode: 3
---

# New Session Workflow

## Required Skills

- @skills:session-management for session folder structure and tracking files

## Step 1: Check for Existing Session

Check if the user has given you a [SESSION_FOLDER] to work in.

**Topic Folder:** If user mentions "topic folder", "topic subfolder", "nested session", "tracked subfolder", or "session subfolder", or requests a new work stream inside an existing session: run @skills:session-management **Topic Folder Creation** procedure instead of creating a new session.

If path already contains NOTES.md, PROGRESS.md, PROBLEMS.md and no new work stream requested: Execute `/session-load` instead.

## Step 2: Collect Session Goal

If no [SESSION_FOLDER] provided, the user MUST provide a brief description of the session goal or topic. This is required to create a correctly named session folder.

If the user invokes `/session-new` without specifying a goal or topic, infer it from the conversation context (user's current request, open files, recent messages). If no goal can be inferred, state: "Please provide a brief description of the session goal or topic for the session folder name."

## Step 3: Create Session Folder

Create a session folder in the default sessions folder with naming scheme:
`_YYYY-MM-DD_[PROBLEM_DESCRIPTION]/`
[PROBLEM_DESCRIPTION] is derived from the session goal collected in Step 2. Should contain only alphanumerical characters without spaces.

## Step 4: Create Session Documents

In the [SESSION_FOLDER], create tracking files from @skills:session-management templates:

- `NOTES.md` - Include "Current Phase" section for phase tracking. If user provides large prompts (>120 tokens), record them verbatim in "User Prompts" section
- `PROGRESS.md` - Include "Phase Plan" section with 5 phases
- `PROBLEMS.md` - Derive and list all problems from user's initial request. Each problem gets unique ID `[TOPIC]-PR-[NNN]` and goes in "Open" section

## Step 5: Initialize Phase Tracking

Add to NOTES.md:
```markdown
## Current Phase

**Phase**: EXPLORE
**Workflow**: (pending assessment)
**Assessment**: (pending)
```

Add to PROGRESS.md:
```markdown
## Phase Plan

- [ ] **EXPLORE** - in_progress
- [ ] **DESIGN** - pending
```

## Step 6: Document Agent Instructions

**Session documents**: See `promptsystem-core.md` sections "Document Types" and "Tracking Documents" for full list and usage.

Read the rules in the agent rules folder and write key instructions into NOTES.md under "IMPORTANT: Agent Instructions".
