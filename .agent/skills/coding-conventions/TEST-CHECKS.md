# Test Checks

Process discipline audit and quality improvement for test writing and execution. Language-agnostic.

**Evidence sources:** test output logs, test files, conftest/setup files, PROBLEMS.md, session NOTES.md, robustness card

## Process Discipline (PD)

### TST-PD-01: Terse Output Mode Used

- Action: agent configured test runner for minimal output in agent sessions
- Evidence: test command in session NOTES.md or prompt includes quiet/terse flags; test output in logs shows compact format (single-character markers or summary-only)
- Failure indicator: test output shows one line per test (verbose mode), or includes version banners and plugin headers
- References: PY-TR-RC-01

### TST-PD-02: Parallel Execution Enabled

- Action: agent enabled parallel test execution using all CPU cores
- Evidence: test command includes parallel flag (e.g., `-n auto`); output shows worker node startup
- Failure indicator: test command lacks parallel flag; output shows serial execution; wall time exceeds expected parallel duration
- References: PY-TR-RC-02

### TST-PD-03: Test Isolation Maintained

- Action: agent ensured each test uses its own temporary directory and shares no mutable global state
- Evidence: test functions accept `tmp_path` or equivalent fixture; no module-level mutable variables used across tests
- Failure indicator: tests write to shared directories; module-level lists/dicts accumulate state across test functions; tests fail when run in different order
- References: PY-TR-TI-01, PY-TR-TI-02

### TST-PD-04: Defect Protocol Followed

- Action: agent marked failing tests with strict expected-failure markers and trackable bug IDs instead of fixing implementation code
- Evidence: expected-failure markers contain bug IDs; same IDs appear in PROBLEMS.md; no implementation file edits in test-writing commits
- Failure indicator: tests marked as expected-failure without bug IDs; implementation files edited during test-writing phase; expected-failure markers without `strict` flag
- References: PY-TR-DP-01

### TST-PD-05: Robustness Card Loaded

- Action: agent loaded the robustness card before executing tests
- Evidence: test commands respect banned command list; time caps applied; on-cap behaviour documented in PROBLEMS.md when caps are hit
- Failure indicator: agent uses banned commands (piping through streaming filters, running full suite in implementation prompts); no time caps applied; agent hangs on stuck command instead of killing and continuing
- References: PY-TR-RC-04, PY-TR-PS-01, PY-TR-PS-02

### TST-PD-06: Mock Transport Used (API-Calling Pipelines)

- Action: agent ran all automated tests against mock transport, not live APIs
- Evidence: environment variable for mock transport set in conftest or test setup; no API key usage in test logs; test duration consistent with mock (seconds, not minutes)
- Failure indicator: test logs show real API calls; test duration suggests live API round-trips; API cost incurred during test run
- References: PY-TR-MT-01, PY-TR-MT-03

### TST-PD-07: Stray Process Sweep Performed

- Action: agent verified no test processes remain after each test run
- Evidence: stray process check command appears after test commands in session logs
- Failure indicator: no process sweep in logs; orphan processes accumulating across prompts
- References: PY-TR-PS-01

### TST-PD-08: Time Caps Applied

- Action: agent applied time caps to test commands and followed on-cap kill procedure
- Evidence: PROBLEMS.md entries for cap hits include command, cap, and last 20 output lines; blocked commands recorded
- Failure indicator: agent waits indefinitely on stuck test command; no PROBLEMS.md entry for cap exceedance; same command allowed to hang repeatedly
- References: PY-TR-PS-02

## Quality Improvement (QI)

### TST-QI-01: Test Coverage Breadth

- Question: does the test suite cover all categories in the test plan, or are some categories missing or underrepresented?
- Improvement tip: map test files to test plan categories. If a category has zero or very few tests, add tests or document why the category is deferred. Use numbered file naming (PY-TR-NM-01) to make gaps visible at a glance.

### TST-QI-02: Fault Injection Depth

- Question: does the mock transport exercise all realistic failure modes (rate limits, timeouts, hangs, truncation, garbage responses), or only the happy path and one error?
- Improvement tip: review the fault vocabulary in TEST-GUIDES.md section 6. For each failure mode, verify at least one test injects it. Prioritize modes that cause silent data loss (truncation, dropped items) over modes that cause loud errors (connection refused).

### TST-QI-03: Reference-Run Comparison Adoption

- Question: are recovery tests using reference-run comparison (hash-based), or do they assert individual file contents with brittle per-file checks?
- Improvement tip: if more than 5 recovery tests assert specific output content, consider replacing them with a single reference hash assertion. This reduces maintenance cost when output format changes and proves end-to-end correctness.

### TST-QI-04: Cost Guard Presence

- Question: for pipelines that make paid API calls, does the test suite include a cost reference profile that catches accidental cost increases?
- Improvement tip: store call counts by purpose, token counts, and computed cost in a reference fixture. Add a test that asserts these values within a small tolerance (e.g., 5%). This catches bugs that add unnecessary API retries before they reach production.

### TST-QI-05: Test Naming Grep-ability

- Question: can you grep for a specific test case ID (e.g., `TC-42`) and immediately find the test function, its file, and its description?
- Improvement tip: use PY-TR-NM-02 naming convention. Embed TC IDs in function names and full descriptions in docstrings. Verify by running `grep -r "TC-42" tests/` and confirming exactly one match.

### TST-QI-06: Parallel Track Interference

- Question: when multiple agents write tests in parallel, have file ownership lists been verified for disjoint-ness?
- Improvement tip: before starting parallel tracks, list all files each track will create or edit. Verify no file appears in two lists. Use a barrier prompt to run the full suite after all tracks complete. If tests fail only during full-suite runs (not per-track runs), suspect shared state violations.

### TST-QI-07: Prompt Verification Block Completeness

- Question: does every test-writing prompt end with a verification block that names the exact test command, expected pass/xfail counts, and stray process check?
- Improvement tip: add a `Verify:` block to every prompt. Include: 1) exact test command, 2) expected test function count, 3) expected outcome (all pass or strict-xfail), 4) stray process sweep command. This catches prompt drift where later prompts accidentally omit verification.
