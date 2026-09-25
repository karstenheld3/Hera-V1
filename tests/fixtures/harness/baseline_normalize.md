# Baseline Normalization List

Volatile fields stripped or replaced by the pass-through equivalence test before comparing two captures of `baseline_scenario.json` through the real three-process Hera.

## Fields replaced with a constant token

- **`ts`** - event timestamp on every JSONL line; replaced with `{TS}`
- **`id`** (tool call IDs) - `tc_0001`, `tc_0002`, etc.; replaced with `{TC_ID}` (also inside `tool_call_id` references and `args_json` strings)
- **`digest`** - prompt step digest (SHA-256 prefix of the prompt text); replaced with `{DIGEST}`
- **`pid`**, **`ppid`** - process IDs; replaced with `{PID}`
- **`durationMs`**, **`duration_ms`** - elapsed time fields; replaced with `{DURATION}`
- **`run_ctx`** - opaque run context from admit(); replaced with `{RUN_CTX}` (varies per run, same value within one run)
- **`seq`** - monotonic per-writer sequence number on every envelope and event; replaced with `{SEQ}` (varies per run)
- **`prompt_id`** - prompt correlation ID on every event record; replaced with `{PROMPT_ID}` (varies per run)

## Paths replaced with a constant token

- **Temp workspace paths** - any path matching `E:/Dev/Hera-V1/tests/.tmp/<label>_<pid>_<timestamp>_<counter>`; replaced with `{TMP_WS}` (appears in `args.file_path`, `args.TargetFile`, `args.SearchPath`, `args_json`, `result`, `content` (cwd), `config_snapshot.data_dir`, and `system_prompt` text)
- **Session IDs** - `YYYY-MM-DD_HHMMSS_<suffix>` patterns; replaced with `{SESSION_ID}`

## Structural normalization

- **Event ordering** - events from concurrent processes (Executor, Supervisor, Communicator) interleave non-deterministically in the JSONL. Normalization sorts all event lines by their stringified JSON after field replacement, producing a canonical order. Causal ordering within a single process is preserved by the sort key (same proc + type + content).

## Fields NOT normalized (stable across captures)

- `proc` - process name (exec, sup, comm)
- `type` - event type
- `role` - model role name
- `text` - assistant text deltas and responses
- `thinking` - thinking text
- `tool` - tool name
- `status` - tool call status (ok, blocked)
- `result` - tool result text (after path replacement)
- `result_chars` - character count
- `stop_reason` - turn stop reason
- `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` - usage from scripted adapter
- `cost_usd` - computed cost (deterministic from fixed usage)
- `kind`, `rule` - supervisor intervention kind and rule
- `turn_index` - turn number
- `index`, `total` - prompt step index and total
- `system_prompt` - system prompt text (after path replacement)
- `config_snapshot` - config fields (after path replacement)
- `prompt_system_fingerprint` - hash and file list (stable for the fake_system fixture)
- `origin` - origin tag `{kind, ref}` on messages; `kind` is one of 7 fixed strings (user, tool, model, memory, file, web, system); `ref` contains prompt_id or tool call ID already normalized by existing rules

## U10 additions: events and fields stripped before comparison

The following four event types are stripped from the JSONL before comparison (they are new in U10 and have no V1 counterpart; stripping them keeps the equivalence baseline stable across the V1 → V2 transition):

- **`model_called`** - emitted before every model invocation; stripped (new event, no V1 counterpart)
- **`memory_written`** - emitted before the memory append; stripped (new event, no V1 counterpart)
- **`halted`** - emitted when both children reply halted; stripped (new event, no V1 counterpart)
- **`run_ended`** - emitted at terminal state; stripped (new event, no V1 counterpart)

The `severity` field on `error` events is stripped when it is derivable from the message prefix:

- **`severity: "warning"`** - stripped when the message starts with `WARNING:` (the prefix stays for rendering)
- **`severity: "notice"`** - stripped when the message starts with `NOTICE:` (the prefix stays for rendering)
- **`severity: "error"`** - stripped when the message has no `WARNING:` or `NOTICE:` prefix (default severity)
