# Test Guide

Read BEFORE writing or running tests. Language-agnostic methods for optimizing test suites in agentic development workflows.

**Source**: `_INFO_HOW_TO_OPTIMIZE_DEVELOPMENT_TESTS.md [DEVTESTS-IN01]`

## 1. Minimize Test Output for Agent Consumption

Agent context windows are finite. Every line of test output consumes tokens. Optimize for the smallest output that still surfaces failures.

**Decision**: Does your test runner support a terse output mode (one character per test)?

- Yes: use it. Configure: suppress headers, suppress caching messages, suppress plugin banners. The agent sees a progress bar of dots and failure markers. Full failure tracebacks still print at the end.
- No: redirect verbose output to a file. Parse only the summary line into the agent's context.

**Key metric**: a 300-test suite should produce fewer than 10 lines of passing output. Verbose mode (one line per test) wastes 60x more tokens for the same information.

**Exception**: human-facing test runs (QA engineers, CI dashboards) keep detailed output per LOG-TS-01 through LOG-TS-07. See LOG-TS-08 for the agentic endorsement.

## 2. Parallelize Test Execution

Serial test execution wastes wall-clock time proportional to suite size. Parallelized execution uses all CPU cores.

**Prerequisites** (language-agnostic):
- Each test creates its own temporary directory for file I/O
- No mutable global state shared between test functions
- No dependency on execution order
- No test writes to a path that another test reads

**Decision**: Does your runner support parallel execution?

- Yes: enable it with "use all cores" mode. Expect 3-5x speedup on an 8-core machine.
- No: split the suite into independent shards and run them in separate processes.

**Caveat**: do not pipe parallel test output through streaming filters that buffer the entire output before processing. This appears to hang. Read output directly or redirect to a file.

## 3. Expected-Failure Defect Protocol

When test-writing and implementation happen in separate agent sessions, a test track that discovers a defect cannot fix it (the fix might break other tracks running in parallel).

**The protocol**:
1. Write the test that exposes the defect
2. Mark the test as "expected failure" with a strict flag and a trackable bug ID
3. Record the defect in `PROBLEMS.md` with the same bug ID
4. Continue writing the next test

**Why "strict" matters**: a strict expected-failure marker makes the test fail if it unexpectedly passes. This forces the developer to remove the marker when the bug is fixed. Without strict mode, a silently fixed bug leaves a dead marker.

**Traceability**: grep for the bug ID finds three things: 1) the test marker, 2) the PROBLEMS entry, 3) the fix commit message. Full chain from test to bug to fix.

## 4. Parallel Test-Writing Tracks

When a test suite exceeds 100 test cases, a single agent session writing all tests sequentially takes hours. Partition test categories into parallel tracks, each in its own agent session.

**Guarantees that prevent interference:**
- Disjoint file ownership: each track has an explicit file list. No file appears in two lists
- Own tests only: a track runs only its own test files during development
- Test-write and fix separation: test tracks never edit implementation code
- No commits during parallel phase: a barrier prompt collects all work and commits once
- Shared artefacts are read-only during the parallel phase

**The barrier**: after all tracks report done, a sequential barrier prompt collects defects, runs the full suite, verifies expected-failure counts match finding counts, and commits atomically.

## 5. Robustness Card for Test Execution

Agents running test suites can hang on commands that wait for stdin, pagers, or unbounded streams. A robustness card is a dedicated document loaded by every prompt that prevents these failures.

**Four sections in every robustness card:**

- **Banned commands**: commands known to hang in this stack
- **Time caps**: maximum duration per command type (single file, full suite, nightly variant, version control operations)
- **Always rules**: positive requirements (terse output flags, stray process checks after every run)
- **On-cap behaviour**: 1) kill the process tree, 2) record in PROBLEMS.md, 3) continue, 4) same command hits cap twice = stop the prompt

**Example**: See `TEST_EXAMPLE_01-RobustnessCard.md` for a complete robustness card template with all four sections.

## 6. Mock Transport for API-Calling Pipelines

Testing a pipeline that makes paid API calls requires a mock transport layer. The mock replaces the HTTP client with scripted responses.

**The fault vocabulary** (language-agnostic):
- `ok` - valid response
- `rate-limit` - 429 with retry header
- `server-error` - 503 (retryable)
- `timeout` - no response within deadline
- `hang` - connection accepted but no data
- `reset` - connection dropped mid-body
- `garbage` - malformed response body
- `truncate` - body cut at N characters
- `refuse` - model or service refuses the request

**Time simulation**: time-dependent tests (backoff, timeout, hang detection) inject a fake clock that advances without waiting. No real `sleep()` calls in tests.

**Zero live calls**: every automated test runs against the mock. A run without the mock and without API keys must fail fast, never hang.

## 7. Reference-Run Comparison

Instead of asserting individual output properties in every test, use a reference-run pattern.

**The pattern:**
1. Run the pipeline fault-free. Record: output hash, call log, cost profile
2. Store the reference as a committed fixture
3. In every recovery test: run with fault, then run again without fault. Assert output hash equals reference

**Advantages over per-file assertions:**
- One reference covers hundreds of output properties
- A format change updates one reference file, not dozens of assertions
- Recovery tests prove end-to-end correctness

## 8. Cost Reference Profiles

When a pipeline makes paid API calls, guard against accidental cost increases with a cost profile per reference run.

**What to store**: call counts by purpose, token counts, computed cost.

**Guard logic**: a test asserts exact call counts with a small tolerance for tokens and cost. A bug that adds unnecessary retries fails the cost guard before it reaches production.

## 9. Test Suite Structure

**File naming by category**: number test files by test plan category for a scannable directory.

**Unit vs integration split**: use a suffix convention (e.g., `_cli`, `_integration`, `_e2e`) to distinguish function-level unit tests from integration tests of the same category.

**Function naming**: embed the test case ID in the function name or docstring for grep-ability.

**Helper organization**: shared helpers in a `helpers/` directory with one file per concern (transport, fixtures, clock, CLI wrapper). Track-specific helpers in separate files to enforce disjoint ownership.

## 10. Integration with Prompt Sequences

**Default test command**: record the exact test command in session NOTES.md so every prompt uses the same invocation.

**Verification blocks**: every prompt ends with a `Verify:` block naming the exact test command and expected outcome (pass/xfail counts, function counts, stray process check).

**Long-running test marker**: tests that run many repetitions or exercise slow paths get a marker excluding them from the default suite. They run once in the final verification phase with a longer time cap.

**Stray process sweep**: after every test run, verify no test processes remain running.

## Review Checklist

- [ ] Test runner configured for minimal output in agent sessions
- [ ] Parallel execution enabled and tests isolated (own temp dirs, no shared state)
- [ ] Expected-failure protocol in place (strict markers with bug IDs)
- [ ] Robustness card exists with banned commands, time caps, and on-cap procedure
- [ ] Mock transport covers all failure modes the pipeline can encounter
- [ ] Reference-run comparison used for recovery tests
- [ ] Cost profiles stored and guarded by tolerance-based assertions
- [ ] Test command recorded in session NOTES.md
- [ ] Verification blocks present in prompt sequences
- [ ] Stray process sweep after every test run
