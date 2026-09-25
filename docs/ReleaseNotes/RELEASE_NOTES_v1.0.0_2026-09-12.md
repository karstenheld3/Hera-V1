# Release Notes: v1.0.0

## Summary

First release of Hera V1: a governed AI agent for knowledge work on files, code, and documents, shipped as one self-contained Windows x64 executable. Three cooperating processes from one binary - Executor (turn loop, tools), Supervisor (review, memory, stall recovery), Communicator (frontends, session log) - with every effect passing a deterministic gate.

## What ships

### Runtime

- Three-process architecture with JSON IPC over `Bun.spawn`; the Communicator is the only writer of the session log and never blocks on a model call
- Executor turn loop with checkpoint compaction, pre-call request fit check, and a read ledger that enforces read-before-edit
- Supervisor with asynchronous rule review, governance notes, memory extraction and retrieval, cost alerts, stall watchdog, and bounded Executor restart
- Crash recovery: an Executor crash loses at most the turn in flight; `--resume` restores a session from its log

### Providers and models

- OpenAI (Responses API), Anthropic (Messages API), Z.ai (Chat Completions API)
- Four model roles - `generating`, `compacting`, `supervisor`, `memory` - configured per role in `agent-config.json`; models validated against a shipped `model-registry.json`
- Usage normalized to four billable categories; per-turn and per-role cost accounting from `model-pricing.json`

### Tools

- 15 tools with wire-compatible names and schemas: `read_file`, `list_dir`, `search` (bundled ripgrep), `edit`, `multi_edit`, `write_to_file`, `run_command`, `command_status`, `search_web`, `read_url_content`, `view_content_chunk`, `trajectory_search`, `todo_list`, `skill`, `ask_user_question`

### Harness

- One gate per effect-producing process; effect descriptors for `tool.invoke`, `model.invoke`, `memory.write`, `net.egress`, `process.spawn`; four answers `allow`, `block`, `pending`, `unavailable`
- Profiles `local` (default guards), `passthrough` (tests), `governed` (external compliance plug; declared)
- Definition hash over prompt system, configuration, tool definitions, and model pins, recorded in the session log
- Single spawn boundary; build-time lint rejects any effect call outside the gate

### Frontends

- Interactive console with built-ins `/help`, `/cost`, `/status`, `/exit`, `/halt`
- Headless `-p "<prompt>"` and `--prompt-file <path>` with `text` or `jsonl` output and exit codes 0, 2, 3, 4
- Agent Client Protocol (ACP) server over stdio (`--acp`) with session load and replay
- Debug console and viewer (`--debug`, `--debug-console`, `--debug-viewer`)

### Prompt system

- IPPS bundled as the default `.agent/` folder: rules, workflows, and skills loaded at startup; workflows invoked as `/name`, skills via the `skill` tool

### Distribution and quality

- `build.ps1` pipeline: pinned Bun, staged bundle, type check, `bun build --compile --bytecode --minify`, smoke test, SHA256 checksums; optional Authenticode signing
- `hera selftest` subcommand with offline and live categories
- 428 automated tests across unit, integration, and black-box layers

## Known limits

- Windows x64 is the only shipped target
- Providers limited to OpenAI, Anthropic, and Z.ai over HTTPS; no on-premise model runtime
- Model Context Protocol (MCP) clients, hooks, and sub-agent delegation are not included
- Trusted workspaces are the intended operating environment; see the README section "Scope and known limits"

## Download

- `hera-1.0.0-bun-windows-x64.exe` with `SHA256SUMS.txt`; the executable reports its pre-release working name at the console, the release name is authoritative
