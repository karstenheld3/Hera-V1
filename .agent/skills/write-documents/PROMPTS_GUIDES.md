# Prompts File Guide

Read BEFORE writing `_PROMPTS_[NN]-[Topic].md` files. Follow `PROMPTS_RULES.md` for verification.

## 1. Classify the Task

Determine what the prompts file accomplishes. This determines decomposition and structure:

1. **Single task** - One prompt, one concern (file edit, question, simple generation)
2. **Multi-step pipeline** - Sequential prompts where each builds on prior output (research -> implement -> test)
3. **Setup + work** - First prompt establishes environment/context, subsequent prompts do the work
4. **Exploration** - Open-ended research or investigation, each prompt refining direction based on prior findings

Single tasks need one prompt. Pipelines and setup+work patterns need multiple. Exploration may need either, depending on how predictable the path is.

## 1b. Scan Existing Workflows Before Designing Prompts

Before writing complex prompts or prompt sequences, scan `[AGENT_FOLDER]/workflows/` to find workflows relevant to the task. This leverages standardized processes defined in the prompt system (PRMT-CT-11).

**Process**:
1. Read all workflow frontmatters (the `description` field in YAML frontmatter) in `[AGENT_FOLDER]/workflows/`
2. Identify workflows whose scope overlaps with any prompt in the sequence (sync, verify, test, deploy, commit, session management, etc.)
3. Load matching workflows entirely to understand their structure, steps, and dispatch patterns
4. Design prompts that reference or invoke these workflows instead of reinventing their logic in prompt prose

**Why**: Workflows encode standardized processes with GLOBAL-RULES, context-specific sections, and quality gates. Reinventing workflow logic in prompt prose bypasses these standards, produces inconsistent output, and creates maintenance burden when workflows evolve.

**Workflow execution vs reference**:
- **Execution** (PRMT-CT-08): Prompt requires the agent to execute the workflow — workflow file MUST be read, steps MUST be followed, output MUST be produced. Slash command on standalone line WITHOUT backticks. Signal: execution verb present (run, use, execute, call, invoke, perform, apply, do).
- **Reference** (PRMT-CT-10): Prompt mentions a workflow as context — no execution requirement, model may load if needed. Wrap in backticks in prose. Signal: no execution verb.

Examples inside fences:
- Execute: /sync on its own line, arguments on next line (no backticks around it)
- Reference: "The `/sync` workflow handles synchronization" (backticks, no execution verb)
- BAD: "Use the `/sync` workflow to sync" (execution verb + backticks = PRMT-CT-08 violation)

**Exception**: If the user explicitly requests prompt system independence, omit `prompt_system` from frontmatter (PRMT-FT-09) and do not reference workflows. The prompts must then be self-contained.

## 1c. Effort-Based Partitioning

The effort level in the frontmatter determines the practical scope of each prompt. Effort is not an inference-time cap but a trained behavioral profile: the model learns different judgment at each level during RL training.

Effort defines two things:

1. **How much work the model can do in one run**: higher effort means the model thinks longer, reads more files, uses more tools, and takes more steps before checking back. Low effort means the model acts fast with minimal exploration
2. **How to partition work into prompts**: at low effort, each prompt must be tightly scoped — one file, one edit, one search. At high effort, a single prompt can handle multi-file analysis, planning, and implementation

The model name, context window size, and effort level together determine how many prompts a task needs. A task that requires 8 prompts at low effort on a model with 8K context may require 2 prompts at high effort on a model with 200K context.

When partitioning, match the prompt count to the effort budget. Mismatched effort and prompt count produces either overloaded prompts (low effort, too many steps per prompt) or underutilized prompts (high effort, unnecessary fragmentation). The frontmatter `effort` and `context_window_size` keys encode this budget (PRMT-SC-05).

## 1d. Planning Document Anchor

A prompt sequence without a persisted planning document is unanchored: the agent cannot determine progress, maintain state, or detect drift. A TASKS or STRUT document is essential because it provides:

1. **Progress tracking**: checkboxes mark step completion. The start-of-prompt protocol reads these to detect already-done steps and skip them. Without this, the agent re-executes completed work or skips unfinished work
2. **State persistence**: the planning document survives context reset. On a fresh session, the agent reads the plan, progress notes, and append-only record to reconstruct "where am I" without replaying conversation
3. **Drift control**: the planning document is the reference point. If the agent's output diverges from the plan, the discrepancy is detectable by comparing against the persisted steps. Without an anchor, drift is invisible — there is no baseline to compare against

Good prompt sequences are anchored by a persisted planning document. The prompts execute steps defined in the plan; the plan tracks which steps are done; the agent reads the plan on resume to determine where to continue. The plan, not the conversation, is the source of truth for sequence state. Each prompt references the planning document by filename and step ID (PRMT-SC-06).

## 1e. Chain Length Limits

Error rates compound across steps. A 5% per-step error rate yields:

- 3 steps: 14% end-to-end failure rate
- 6 steps: 26% end-to-end failure rate
- 10 steps: 40% end-to-end failure rate
- 15 steps: 54% end-to-end failure rate

Keep sequences under 6 steps. For longer workflows, split into sub-chains with checkpoints between them. Each sub-chain completes, commits, and the next sub-chain starts fresh with its own self-contained opening. This limits the blast radius of a single step failure to its sub-chain, not the entire workflow (PRMT-SC-04).

Common mistake: splitting every task into 5 prompts. Static decomposition with no conditional logic costs more than a monolithic prompt if early steps fail and force reruns of all downstream steps. Balance chain length against the effort budget (Section 1c).

## 2. Decide Decomposition

Split into multiple prompts when:
- The task has more than one reasoning mode (research vs implementation vs validation)
- Intermediate output should be reviewed before continuing
- One step produces a large artifact the next step consumes

Keep as one prompt when:
- Single reasoning mode (one edit, one search, one generation)
- No intermediate checkpoint needed
- Splitting adds coordination overhead without quality benefit

Common mistake: splitting every task into 5 prompts. Static decomposition with no conditional logic can cost more than a monolithic prompt if early steps fail and force reruns of all downstream steps.

## 3. Structure Each Prompt

Every prompt contains up to four parts, in this order:

1. **Objective** - What the finished state looks like (1-3 sentences). State the outcome, not implementation steps. "Fix the auth bug so expired tokens return 401" not "Open file X, add try-catch on line Y"
2. **Context** - Facts the agent needs but cannot infer: tech stack, relevant files (1-3), business rules, conventions. Selective, not exhaustive. Treat context window as a budget
3. **Constraints** - What NOT to do: no new dependencies, do not modify schema, stay within these files. Constraints prevent more failures than detailed instructions
4. **Verification** - Machine-checkable success criteria: "run tests", "endpoint returns 200", "file exists with these sections". Without this, the agent decides when it is done

Not every prompt needs all four. A simple "list all Python files" needs only the objective. An implementation prompt needs all four. Rule of thumb: the higher the stakes, the more parts you include.

When a prompt must produce output in a specific format, add an optional 5th element: **Example** (between Constraints and Verification). See section 9 for when examples are worth the tokens.

## 3a. Interleaved Verification Prompts

Sequences with 4 or more implementation prompts must include interleaved verification prompts every 2-3 implementation prompts (PRMT-SQ-04). A verification prompt runs `/verify` against the planning document (STRUT or TASKS) and the prompts file for prompts executed so far, then runs `/fix` to address gaps and remaining work.

**Why interleave verification**: Without checkpoints, spec-code drift accumulates across prompts. A Lana-V2-Dev SecurityRemediation sequence had 5 sub-chains with 3-5 prompts each. Drift was only caught at the end, requiring expensive rework across the full sequence. Interleaved verification catches drift at the point of occurrence, limiting blast radius to 2-3 prompts.

**Verification prompt structure**:
- Self-contained opening (PRMT-SC-01): reads rules card and planning document
- `/verify` workflow call on standalone line (PRMT-CT-08): verifies current state against planning document for prompts executed so far
- `/fix` workflow call on standalone line (PRMT-CT-08): fixes all gaps and remaining work
- No implementation content — no code, tests, or builds
- Does NOT count toward chain length limit (PRMT-SC-04)

**Placement**: Insert after every 2-3 implementation prompts. For a 5-prompt sequence: after prompt 2 and after prompt 4. For a 3-prompt sequence: no interleaved verification needed (final verification suffices).

**Example verification prompt**:
`````markdown
## Verification Checkpoint 1

<!-- Verify prompts 1-2 against STRUT before continuing. -->

```
Read `__CARD_00-Rules.md` and `__STRUT_[Topic].md`. Treat earlier conversation as compacted. Verification checkpoint after prompts 1-2.

/verify

current state against `__STRUT_[Topic].md` for prompts executed so far.

/fix

all gaps and remaining work.
```
`````

**Heading convention**: Use `## Verification Checkpoint N` (not `## Prompt N`) to distinguish verification prompts from implementation prompts. This makes it easy to count implementation prompts for chain length and identify which prompts are checkpoints.

## 4. Plan State Flow

In a `_PROMPTS_[NN]-[Topic].md` file, prompts run as turns of one session but must not rely on conversation history. Each prompt must be self-contained: it names its dependencies by file path, not by conversation reference. The chain holds the state through files, not through model memory of prior prompts.

Plan what each prompt produces that the next one needs:
- Name artifacts explicitly by file path: "Using the analysis in `_INFO_DatabaseDesign.md` section 2..."
- Do not reference "the previous step" or "as discussed above" without naming where the output lives in a file (PRMT-SC-02)
- Do not assume the model remembers prior conversation — treat earlier conversation as compacted; reconstruct state from files
- Never contradict constraints from earlier prompts
- Use commentary sections to document expected state for human readers, not to carry model context

Use commentary sections (before the first prompt or between `---` and next fence) to document expected state for human readers. Commentary notes MUST be wrapped in HTML comments (`<!-- ... -->`). Commentary density depends on file type:

- **Final output files**: heading + max 1 sentence in one HTML comment per prompt. The sentence captures expected state for the human reviewer. More than one sentence is noise — the prompt itself carries the detail.
- **Template files**: no limit. Templates need authoring instructions, placeholder explanations, and conditional guidance that get removed when filling the template.

## 5. Manage Prompt Density

Practitioner heuristic: limit each prompt to 5-8 high-priority rules or instructions. Beyond that, the model tends to skip items in the middle of long lists (lost-in-the-middle effect). The exact threshold varies by model and task.

If a prompt needs more than 8 instructions:
- Split into two prompts (first sets up, second executes)
- Move standing rules into the agent's rules file instead of repeating per-prompt
- Promote the most critical constraints to the top and bottom of the prompt (models attend to edges)

## 6. Handle Failure Paths

For prompts that perform actions (file changes, API calls, installations):
- State what to do if the action fails: retry, skip, or abort
- Define retry limits if applicable: "If tests fail after 2 attempts, document failures and continue"
- Specify stop conditions: "If no matching files found, report and stop - do not create placeholder files"

Prompts without failure handling produce agents that either loop indefinitely or silently suppress errors and continue on broken state.

## 6a. Self-Contained Prompt Pattern

Every prompt in a sequence must be self-contained: it carries all information needed to execute after agent context reset. A prompt that assumes context from previous prompts breaks when execution is interrupted and resumed.

The core principle: treat earlier conversation as compacted. Prior conversation is not in context; reconstruct state from files, not from memory. Each prompt opens with a context-loading directive that names the files to read before doing anything else. The prompt never relies on model memory of prior prompts (PRMT-SC-01).

Every prompt begins with three elements:

1. A context-loading directive naming the files or cards to read
2. An explicit statement that earlier conversation is not in context: "Treat earlier conversation as compacted"
3. A step identifier (STRUT step, task ID, or sequence position) for progress tracking

Shared information between prompts is either referenced (document path + line numbers) or stored in context cards (`__CARD_*.md` files) that each prompt reads and updates. Use references when information has a stable home in a file. Use context cards when shared information does not have a stable home.

For complete examples, see:
- `PROMPTS_EXAMPLE_01-SelfContainedSequence.md` — 3-prompt self-contained sequence with STRUT anchor and context cards
- `PROMPTS_EXAMPLE_02-RobustnessCard.md` — complete robustness card with banned commands, time caps, always rules
- `PROMPTS_EXAMPLE_03-FindingsCard.md` — complete findings card with resolved glitches, unresolved blocker, six-field entry format

## 6b. Idempotency in Prompts

Idempotency means re-running a prompt produces the same result without corrupting state or wasting cost. A prompt sequence must be safe to re-run after interruption, partial execution, or accidental double-execution (PRMT-SC-03).

Key idempotency practices:

- **Pre-execution check**: detect already-done steps and stop before doing work. This is the primary idempotency guard — it prevents re-execution entirely when the step completed successfully
- **Partial execution recovery**: if a prompt was interrupted mid-execution, the next run must detect partial state and recover. Check for output artifacts before creating them: if the file exists and passes structural validation, skip; if it exists but fails validation, overwrite; if it does not exist, create
- **Write-to-temp-then-rename**: write output to a `.tmp` file first, verify it, then atomically rename to the final filename. If interrupted between delete and create, the original is lost — this pattern prevents that
- **Cost guard**: before re-running expensive operations (API calls, builds, test suites), check if the output already exists and is valid. Cache results to files so a re-run reads the cache instead of re-calling the API
- **No destructive operations without backup**: never delete a file then recreate it. Write to a temp file, verify, then atomically rename

Implementation prompts should include an idempotency constraint in the Constraints section stating that re-running the prompt must not corrupt state or waste cost.

## 6c. Hang-Safety in Prompts

Prompt sequences run unattended. One command waiting for a keypress, stdin, a pager, or an unbounded child process blocks every later prompt in the file. The execution engine cannot skip a hung prompt. The entire sequence is dead.

A well-structured prompt sequence with precise objectives, clean state flow, and verified idempotency is worthless if the agent issues a single hanging command in prompt 3 of 5. Hangs are the most common failure mode in unattended prompt execution.

**Every implementation prompt** (any prompt that runs commands) MUST include a hang-safety clause in the Constraints section. The clause has three parts:

1. **Prohibition**: no command may wait for a key, stdin, a pager, or an unbounded child
2. **Banned list**: project-specific commands known to hang
3. **Cap behavior**: what to do when a command exceeds its time cap

See `PROMPTS_ROBUSTNESS_GUIDES.md` for the clause template, project-specific banned lists, safe command patterns, findings-card mechanism, and lessons from a harness rewrite session. Verify against PRMT-HS-01 through PRMT-HS-08 and PRMT-RB-01 through PRMT-RB-07 in `PROMPTS_RULES.md`.

### Hang-Safety Clause Template

```
Hang safety: no command may wait for a key, stdin, a pager, or an unbounded child. Banned: [project-specific list]. Test suites run non-blocking with a [N]-minute cap. On cap: kill the process tree, record command and cap in PROBLEMS.md, continue.
```

### Common Hang Risks

- `2>&1` with `Blocking: true` — PowerShell pipe deadlock (reading one stream to completion before the other deadlocks when the unread stream fills its pipe buffer)
- `git log` without `--no-pager` — launches a pager
- `build.bat`, `ship.bat` — often contain `pause`
- `bun --watch`, `npm run dev` — never terminate
- `Read-Host`, `pause`, `Get-Credential` — wait for stdin
- Sequential `run_command` approvals — agent appears frozen between commands

### Verification Gaps Beyond Hangs

A harness rewrite session revealed verification gaps that silently pass as "done." Include these in Verify sections:

- **Name specific test files** when code changes affect tests (prevents regressions surviving multiple prompts)
- **Residual sweeps** when concepts are removed (prevents old terms persisting in code)
- **Prior-step confirmation** when a prompt depends on a prior step (prevents STRUT sequencing violations)

## 6d. Tool Preference in Prompts

Prompts must direct the agent to use built-in tools (grep_search, read_file, find_by_name, code_search) for file search, read, and list operations. Shell commands (Select-String, Get-ChildItem -Recurse, Get-Content, cat, grep, find, rg.exe) must not appear in prompt bodies for file exploration or reading (PRMT-CT-12).

Shell commands are for process execution only: builds, tests, git operations, and explicit residual sweeps in verification sections. The prompt body describes objectives and constraints, not implementation steps (PRMT-CT-04). Embedding shell commands for file search in the prompt body is micromanagement that also creates hang risks.

**Why agent tools over shell commands**:
- Agent built-in tools are non-hanging by design — no pipe deadlocks, no recursive enumeration hangs
- Agent tools respect workspace permissions and gitignore rules
- Agent tools are faster for single-file reads and targeted searches
- Shell commands for file operations were a primary hang source in a Lana-V2-Dev session: `Get-ChildItem -Recurse` on large trees, `Select-String -Recurse`, `Get-Content -Wait`

**Where shell commands ARE acceptable**:
- Verify sections: residual sweeps (`Select-String -Pattern 'old_term' -Path src/` returns zero matches)
- Build/test/git commands: `bun test`, `npm run build`, `git --no-pager log`
- Commands that have no agent-tool equivalent

**How to write file operations in prompt bodies**:
- Instead of "Run `Select-String -Pattern 'foo' -Path src/ -Recurse`", write "Search for 'foo' in src/ using the grep_search tool"
- Instead of "Run `Get-Content file.ts`", write "Read `file.ts`"
- Instead of "Run `Get-ChildItem -Recurse -Filter *.ts`", write "Find all .ts files in src/ using the find_by_name tool"

## 6e. Execution Authority in Prompts

Prompt sequences run unattended. If the agent stops to ask for confirmation before executing, the execution engine treats the paused prompt as complete and advances to the next prompt. Work is skipped, state is corrupted, and the sequence fails silently.

Every implementation prompt MUST include "Execute without asking for confirmation" in the Constraints section (PRMT-EX-03). This overrides default confirmation gates for the duration of prompt file execution. The Constraints section defines the boundaries — what NOT to do. Within those boundaries, the agent executes without asking.

**Why this matters**: agent rules (e.g., `agent-behavior.md` confirmation rules) are designed for interactive pair programming. In headless prompt execution, the same rules cause indefinite hangs. The execution authority constraint explicitly disables confirmation gates for the current prompt.

**Where to place it**: in the Constraints section, alongside idempotency and hang-safety. It is a negative constraint (PRMT-CT-02): it states what the agent must NOT do (ask for confirmation).

**Example**:
```
Constraints:
- Do not modify the token generation logic
- Execute without asking for confirmation
- Re-running this prompt must not corrupt state or waste cost
- Hang safety: no command may wait for stdin, a pager, or an unbounded child
```

## 6f. Timestamp Source

Document History timestamps must come from the prompt's request metadata, not from the agent's internal clock or training data. Agents estimate timestamps poorly — sometimes drifting by hours or days. The request metadata contains the actual submission timestamp, which is the authoritative source.

**Example**: A prompt submitted at `2026-03-19 10:15` must produce a Document History entry reading `[2026-03-19 10:15]`, not `[2026-03-20 14:30]` (extrapolated). Instruct the prompt: "Use the timestamp from this prompt's request metadata for the Document History entry." (PRMT-CT-13)

## 6g. Banned-Term Sweep Recording

When recording a banned-term sweep in Document History or findings, describe the pattern shape (e.g., "swept for banned terms in filenames"), not the literal banned pattern. Spelling the banned literal in the recording plants it in the document, defeating the purpose of the sweep.

**Example**: Instead of "Swept for `deprecated_api_v2` in filenames", write "Swept for banned terms in filenames". The banned term never appears in the recording. (PRMT-CT-14)

## 6h. Spec-Code Consistency Check

When a prompt changes code that has an associated spec, the Verify section must check that the spec still matches the code. The Verify section names the spec file and the clauses affected by the code change. Without this check, specs drift and become stale.

**Example**: A prompt changing token expiration from 30 to 60 minutes in `src/auth/issuer.ts` must verify: "Check `_SPEC_Auth.md` section 3.2 (Token Expiration) still matches the new 60-minute TTL. Update spec if drifted." (PRMT-HS-10)

## 7. Select Fence Length

Examine each prompt for inner fenced code blocks:

- No inner fences → 3 backticks
- Contains ``` blocks → 4+ backtick outer fence
- Contains ```` blocks (markdown examples with ``` inside) → 5+ backtick outer fence
- Maximum: 9 backticks

When in doubt, use one more backtick than the deepest inner fence. The parser closes at the first line with >= N backticks.

## 8. Prioritize Precision Over Token Savings

Prompts are instructions, not documentation. The APAPALAN priority order applies: **Precision first (Priority 1), Brevity second (Priority 2)**. A vague 20-token prompt that produces wrong output costs more than a precise 200-token prompt that succeeds on first execution.

### 8.1 Why Token Savings Backfire in Prompts

The cost equation for prompts differs from documentation:

- **Failed prompt** = full re-execution (thousands of tokens wasted), debugging time, potentially corrupted state
- **Precise prompt** = extra 50-100 tokens upfront, correct output on first run
- **Ratio**: One failed re-execution costs 10-50x more tokens than the precision tokens would have

The SKILL_GUIDES.md "Token Optimization" section (section 4) applies to skill files that sit in the context window permanently. Prompts are different: they execute once, and the cost of failure is re-running the entire prompt sequence.

### 8.2 Where to Invest Tokens (Precision Wins)

Spend tokens on content that prevents misunderstanding or wrong action:

- **Specific objectives** - "Fix the auth bug so expired tokens return 401" vs "Fix the auth bug" (AP-PR-07)
- **Constraints** - "Do not modify the database schema" prevents a class of failures no amount of brevity recovers from
- **Verification criteria** - "Run `pnpm test`. All tests pass" is 8 tokens that prevent unbounded debugging
- **Disambiguation** - "The `user` table (PostgreSQL, not the application User model)" prevents the model from editing the wrong thing
- **Examples** - A 3-line input/output example communicates format more precisely than a 10-line description (AP-BR-05)

MECT's "deliberate redundancy" applies here: restating a referent ("the authentication retry" instead of "it") costs 2 tokens but prevents the model from binding "it" to the wrong antecedent. This is signal redundancy - it strengthens the model's understanding, not noise.

### 8.3 Where to Save Tokens (Brevity Applies)

After precision is secured, cut aggressively:

- **Filler phrases** - "I would like you to please" → just state the objective
- **Restating known context** - If prompt 1 established the tech stack, prompt 3 does not need to repeat it (conversation history persists)
- **Generic instructions** - "Write clean, well-documented code" adds zero signal. The model already does this by default
- **Implementation micromanagement** - "Open file X, go to line Y, add Z" wastes tokens on steps the model can determine itself (PRMT-CT-04)
- **Politeness tokens** - "Could you kindly", "Thank you in advance" - the model does not respond to social cues

### 8.4 The MECT Test for Token Value

For every phrase in a prompt, apply MECT's signal vs noise distinction:

- **Signal** = Removing this phrase forces the model to guess. Keep it.
- **Noise** = Removing this phrase changes nothing about the model's understanding. Cut it.

When uncertain: keep the phrase. Precision (Priority 1) wins over brevity (Priority 2). A prompt that is 20% longer but unambiguous beats a terse prompt that the model misinterprets.

## 9. When to Include Examples

Examples are the highest-precision, lowest-ambiguity way to communicate format and behavior. AP-BR-05 (show format over describing format) applies directly: a 3-line example replaces a 10-line description and communicates more precisely.

### 9.1 When Examples Are Worth the Tokens

- **Output format matters** - If the prompt must produce a specific structure (JSON, markdown table, config file), show one complete example of the expected output
- **Pattern must be replicated** - If the agent must follow an existing codebase pattern, include a representative sample
- **Edge cases need handling** - Show the edge case input and expected output, not a description of the edge case
- **Ambiguity exists** - When the same instruction could produce two valid but different outputs, an example resolves which one you want

### 9.2 When Examples Waste Tokens

- **Behavior is obvious** - "Create a Python file with a main function" needs no example
- **The codebase IS the example** - If the agent can read existing files, reference them instead: "Follow the pattern in `src/api/users.py`"
- **Multiple valid outputs** - If any reasonable format is acceptable, an example over-constrains

### 9.3 Example Placement in Prompts

Place examples after the objective and constraints, before verification. The structure becomes:

1. Objective (what)
2. Context (relevant files, facts)
3. Constraints (what NOT to do)
4. Example (what the output looks like)
5. Verification (how to check)

Keep examples minimal: one representative instance, not three variations of the same pattern. The model generalizes from one example better than it follows a verbose description.

### 9.4 Examples and Fence Depth

Examples containing code blocks require deeper outer fences. A prompt showing a markdown example with ``` inside needs a 4+ backtick outer fence. Plan fence depth AFTER writing examples (section 7).

## 10. Optional Execution Frontmatter

Execution Frontmatter (PRMT-FT-08) is an optional YAML block at the very top of the file. It provides execution hints to the execution engine.

### 10.1 When to Include Frontmatter

Include frontmatter when:
- The prompts are designed for a specific model or reasoning level
- The execution engine supports frontmatter and benefits from hints
- The prompt sequence is part of a prompt system (e.g., IPPS)

Omit frontmatter when:
- The prompts are model-agnostic
- No specific reasoning settings are needed
- Simplicity is preferred over explicitness

### 10.2 Supported Keys

- `intended_model`: Model identifier (e.g., `claude-sonnet-4-5`, `gpt-4o`)
- `context_window_size`: Context window size (e.g., `200k`, `128k`, `1M`)
- `effort`: Effort level (`low` | `medium` | `high` | `extra-high`)
- `prompt_system`: Prompt system identifier (e.g., `IPPS`)

### 10.3 Key Principles

- **Optional**: The execution engine decides whether to honor frontmatter or use its own configuration
- **Portability**: The same prompt file can run on different engines with different models
- **Never sent to model**: Frontmatter is metadata for the execution engine, not prompt content
- **File start only**: Frontmatter must be the first content in the file (no blank lines before opening `---`)

## 11. Prompt Markers

Every prompt MUST include a Prompt Marker as the first line inside each prompt's fence, followed by an empty line before the prompt content (PRMT-FT-10). The marker shows the current prompt number and total count in zero-padded format, followed by a summary of the prompt's purpose:

```
Setup API Module [ 01 / 23 ] - Analyze requirements

Read `__CARD_00-Rules.md`...
```

The summary matches the heading text. When the sequence is derived from a planning document (STRUT, TASKS, IMPL per PRMT-SC-06), the summary MUST include plan phase/step references:

```
Security Fix [ 01 / 07 ] - P4-S1 U10 stage A: untrusted-content delimiters in specs

Read `__CARD_00-Rules.md`...
```

### 11.1 Why Prompt Markers Matter

- **Orientation**: The agent knows how far along the sequence is at a glance
- **Progress tracking**: The marker complements STRUT step IDs — STRUT tracks the plan, the marker tracks the file
- **Resume after interruption**: When reloading a prompt file after context reset, the marker shows which prompt is next without counting fences
- **Human readability**: When reviewing a long prompt file, the marker makes navigation immediate
- **Summary**: The marker line always includes a summary matching the heading text, giving the model the same orientation the heading gives the human reader — without requiring the model to read the heading (which is commentary, never sent)
- **Plan summary**: When using a planning document, the summary includes plan phase/step references for additional context

### 11.2 Format Rules

- Zero-padded to match the width of the total count (5 prompts → 2 digits, 23 prompts → 2 digits)
- Total count is the number of prompts in the file, not STRUT steps
- For sub-chains (PRMT-SC-04): total count is the number of prompts in the current sub-chain file
- The marker goes inside the fence as the first line of prompt content, followed by an empty line before the prompt content — the model sees it for progress tracking
- The marker line MUST include a summary: `Human Readable Prefix [ NN / NN ] - [brief summary]`. The summary matches the heading text
- When using a planning document (PRMT-SC-06), the summary MUST include plan phase/step references: `Human Readable Prefix [ NN / NN ] - [plan step ID] [brief summary]`
- Required for all sequences, including single-prompt files

## 12. Execution Model: One Prompt Per Turn

Prompt files are NOT executed as a single run. Each Prompt Block is a separate turn: submitted individually to the model, with the model response received before the next prompt is submitted.

### 12.1 Why Separate Turns Matter

Each turn receives the agent's full context engineering, input rendering, and compute budget. This is the entire point of prompt files - working around the context, compute, and output limits of a single model run:

- **Context engineering**: The agent applies its internal input rendering mechanisms to each turn independently. Concatenating prompts bypasses this.
- **Compute budget**: Each turn gets fresh reasoning compute. A 3-prompt sequence gets 3x the compute when run as separate turns vs one concatenated run.
- **Execution depth**: A single run produces one response with limited depth. Separate turns allow each step to produce a full response, building on prior turns.

### 12.2 Agent Role vs Execution Engine Role

The writing agent creates the prompt file. The execution engine (Lana, headless runner, or human submitting one prompt at a time) runs it. These are separate roles.

An agent that writes a prompt file and then immediately executes all prompts in a single response is NOT executing the prompt file - it is circumventing the format. The agent collapses the sequence into one turn, losing per-turn context engineering and compute allocation.

### 12.3 What to Do Instead

After writing a prompt file:
- Deliver the file to the user or execution engine
- Do NOT self-execute the prompts in the same response
- If the user asks to execute, hand off to the execution engine or guide the user to run it

## 13. Review Checklist

Before considering the prompts file complete:

- [ ] Existing workflows scanned and referenced where applicable (PRMT-CT-11)
- [ ] Workflow execution vs reference distinction: execution verb (run, use, execute, call, invoke, perform, apply, do) + workflow name = execution on standalone line without backticks, arguments on following line (PRMT-CT-08); no execution verb + workflow name = reference in backticks (PRMT-CT-10)
- [ ] `prompt_system` frontmatter empty/omitted if user requested independence (PRMT-FT-09)
- [ ] First non-empty line is optional frontmatter (PRMT-FT-08), Commentary, or opening fence (no other frontmatter)
- [ ] Each prompt has a clear objective (verifiable from artifact per PRMT-ST-01)
- [ ] Implementation prompts have constraints and verification criteria
- [ ] No prompt mixes more than one reasoning mode (research + implement = split)
- [ ] Sequential prompts do not contradict earlier constraints
- [ ] Later prompts explicitly reference prior output when dependent
- [ ] Commentary sections explain purpose for human readers, not duplicate prompts
- [ ] Fence lengths exceed all inner fence lengths within each prompt
- [ ] `---` separator between every pair of consecutive prompts
- [ ] If headings are used, ALL prompts have headings (PRMT-FT-07)
- [ ] Each prompt includes a human-readable prefix `[ NN / NN ]` Prompt Marker as first line inside fence (PRMT-FT-10); when using a planning document, marker includes plan summary: `Human Readable Prefix [ NN / NN ] - [plan step ID] [brief summary]`
- [ ] No prompt content outside fences (would be silently dropped)
- [ ] Precision tokens preserved: constraints, verification, disambiguation not cut for brevity (PRMT-CT-05)
- [ ] Signal redundancy preserved: explicit referents, not pronouns for ambiguous antecedents (PRMT-CT-06)
- [ ] Format-critical prompts use examples instead of prose descriptions (PRMT-CT-07)
- [ ] Commentary notes wrapped in HTML comments (`<!-- ... -->`), headings as plain Markdown (PRMT-FT-04)
- [ ] Each prompt has a self-contained opening: context-loading directive, "treat earlier conversation as compacted", step identifier (PRMT-SC-01)
- [ ] No prompt references "the previous step" or "as discussed above" without naming where output lives in a file (PRMT-SC-02)
- [ ] Implementation prompts include idempotency constraint: re-running must not corrupt state or waste cost (PRMT-SC-03)
- [ ] Sequence stays under 6 steps; longer workflows use sub-chains with checkpoints (PRMT-SC-04)
- [ ] Frontmatter specifies effort level; prompt count matches effort budget (PRMT-SC-05)
- [ ] Prompt sequences from planning documents reference the document by filename and step ID (PRMT-SC-06)
- [ ] Implementation prompts include execution authority constraint: "Execute without asking for confirmation" (PRMT-EX-03)
- [ ] Agent does not self-execute the prompt file (PRMT-EX-02): file is delivered, not run in one response
- [ ] Every implementation prompt includes a hang-safety clause: prohibition, banned list, cap behavior (PRMT-HS-01)
- [ ] Banned command list is project-specific, not generic only (PRMT-HS-02)
- [ ] Time caps specified for all command executions (PRMT-HS-03)
- [ ] On-cap behavior: kill, record in PROBLEMS.md, continue (PRMT-HS-04)
- [ ] Process cleanup after command execution: verify no orphans (PRMT-HS-05)
- [ ] No interactive commands: no stdin reads, pagers, unbounded children, 2>&1 blocking (PRMT-HS-06)
- [ ] Verification names specific test files when code changes affect tests (PRMT-HS-07)
- [ ] Verification includes residual sweeps when concepts are removed (PRMT-HS-07)
- [ ] Dependent prompts verify prior step is done before proceeding (PRMT-HS-08)
- [ ] Findings card designated for the sequence (PRMT-RB-01)
- [ ] Every implementation prompt includes a Findings card directive (PRMT-RB-02)
- [ ] Findings card loaded at prompt startup for unresolved entries (PRMT-RB-03)
- [ ] Glitches filed in findings card before end-of-prompt commit (PRMT-RB-04)
- [ ] Session PROBLEMS.md records deferred problems, not detailed glitch logs (PRMT-RB-07)
- [ ] No shell commands for file search/read in prompt bodies — agent tools only (PRMT-CT-12)
- [ ] No contradictions between prompts in the same file (PRMT-SQ-01)
- [ ] Dependent prompts reference prior output by file path (PRMT-SQ-02)
- [ ] Commentary documents expected state between prompts (PRMT-SQ-03)
- [ ] Sequences with 4+ implementation prompts include interleaved verification prompts (PRMT-SQ-04)
- [ ] Verification runs specific test files, not full suite, during implementation steps (PRMT-HS-09)
- [ ] Document History timestamps use request metadata, not extrapolated times (PRMT-CT-13)
- [ ] Banned-term sweep recordings describe pattern shape, do not spell banned literals (PRMT-CT-14)
- [ ] Verify section checks spec-code consistency when prompt changes code with associated spec (PRMT-HS-10)
- [ ] Filename includes zero-padded sequence number `_PROMPTS_[NN]-[Topic].md` (PRMT-NM-03)
