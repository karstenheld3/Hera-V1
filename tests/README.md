# Hera V1 Tests

Layers, all on `bun:test`:

- `unit/` - pure functions, schemas, parsers; no subprocess, no network; filesystem only under `tests/.tmp/`
- `integration/` - real child processes spawned with `ipc`, scripted adapter, temp app directory
- `integration/blackbox_*.test.ts` - the real entrypoint driven through `HeraProc` (headless or piped stdin)
- `live/` - provider round trips; every test is wrapped in `liveTest()` and skips without the provider key. Not part of `bun run test`; run with `bun run test:live` (spends real tokens, capped by `HERA_LIVE_BUDGET_USD`, default 1)
- `harness/` - shared drivers and assertions (`HeraProc`, `FakeComm`, `assertNoSecretLeak`, `hasKey`)
- `fixtures/` - generic content only; never real keys, names, or machine paths

Test names carry a stable test-case id (for example `HERAV1AGNT-TP01-TC-05`) so `bun test --test-name-pattern` can select a group.

Environment:
- `HERA_TEST_BINARY=<path>` - run the black-box and integration layers against the compiled binary instead of `bun run src/index.ts`
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ZAI_API_KEY` - enable the live layer (or the presence of the variable name in `config/.api-keys.txt`)
