# Release Notes: v1.1.0

## Summary

Security hardening release. Seven deterministic controls are added to the `local` profile and active with the default configuration. The harness architecture and the no-permission-question ("Turbo") console behavior are unchanged; the only new interaction is an approval prompt for shell commands the model has not marked as safe.

## New controls

- **Command approval**: `run_command` is held for human approval (`pending`) when `SafeToAutoRun` is not `true`, when the first token is a network command (`curl`, `wget`, `ssh`, and others), or when `Cwd` is outside the workspace; otherwise it is allowed. Denylisted and shell-wrapped commands remain blocked outright. Policy key `harness.local.approval`: `unsafe` (default), `all`, `off`
- **Untrusted-content separation**: results of `read_file`, `list_dir`, `search`, `run_command`, `command_status`, `search_web`, `read_url_content`, `view_content_chunk`, and `trajectory_search` are wrapped in `<untrusted_content>` delimiters with an origin tag; the system prompt instructs the model to treat delimited content as data, never as instructions
- **Credential isolation**: API keys are resolved from environment variables first, then `config/.api-keys.txt`; startup warns when keys are file-sourced; `keys.allow_file: false` disables the key file entirely; the system prompt no longer discloses the agent folder or app directory paths
- **Egress inspection**: key-shaped tokens in URLs, search queries, and command lines are blocked before dispatch
- **Memory integrity**: every memory line carries an HMAC-SHA256 `mac` keyed by a 32-byte secret in `<app dir>/memory.secret`; tampered or unkeyed lines are dropped on load with one WARNING; legacy lines are tagged once; injected memories carry provenance labels inside untrusted-content delimiters
- **Profile integrity**: one plug factory; `governed` refuses to start without its plug (`ERROR: profile 'governed' requires an ACOL plug; none is bundled in this build`); `passthrough` prints `WARNING: profile passthrough - no guards, no approvals` at every start; `agent-config.json` is a protected path
- **Read boundary**: `read_file`, `list_dir`, and `search` are confined to the workspace plus `harness.local.read_allowlist`; `harness.local.protected_paths` (default: `.api-keys.txt`, `agent-config.json`, `memory.secret`, `~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `**/.env*`, `**/*.pem`, `**/id_rsa*`) denies both read and write even inside the workspace or allowlist

## Behavior changes

- **Interactive approval widget**: shows command line, working directory, and reason; `y` allows, `n` or Escape denies. In pipe mode the console prints `Approve run_command: <summary>? [y/n]` and reads the next input line
- **Headless deny**: `-p` and `--prompt-file` answer every pending approval with `deny` and print `NOTICE: run_command '<first token>' denied - headless mode has no approver; use --approve-all or SafeToAutoRun`; the new `--approve-all` flag answers `allow` instead
- **Profile change notice**: when the previous session ran under a different profile, startup prints `NOTICE: profile changed from '<previous>' to '<current>' since the previous session.`
- **Key-file warning**: `WARNING: <n> key(s) loaded from .api-keys.txt - prefer environment variables` on stderr when any key is file-sourced
- **Selftest**: new offline category `10` (LocalGuards controls) verifies all seven controls without a model call

## Upgrade notes

- Existing sessions and memory files load unchanged; memory lines are tagged with `mac` on first load
- Scripts that relied on unattended `run_command` execution must either set `SafeToAutoRun: true` in the tool call, pass `--approve-all`, or set `harness.local.approval: off` (prints a startup WARNING)

## Download

- `hera-1.1.0-bun-windows-x64.exe` with `SHA256SUMS.txt`; the executable reports its pre-release working name at the console, the release name is authoritative
