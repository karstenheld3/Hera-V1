# src/bundled/ - Staging Folder

This folder is populated by `build.ps1` stage 2 (bundle sync) and embedded into the compiled binary via `with { type: "file" }` imports and `--asset src/bundled/agent`.

## Structure

```
src/bundled/
  index.ts          # Embedded imports + materialize(appDir) function
  README.md         # This file
  config/           # Staged model-*.json (gitignored, synced from .agent-data/config/)
  agent/            # Staged .agent/ prompt library (gitignored, synced from .agent/)
  tools/rg.exe      # Staged ripgrep binary (gitignored, synced from .agent-tools/)
```

## Rules

- **Never edit** files in `config/`, `agent/`, or `tools/` - they are overwritten on every `build.ps1` sync.
- **Never commit** the staging subfolders - they are gitignored (`.gitignore` lines `src/bundled/config/`, `src/bundled/agent/`, `src/bundled/tools/`).
- `config/.api-keys.txt` and `config/agent-config.json` are **never** staged - the build asserts this.
- The key-leak guard scans all staged files for real-key-shaped `*_API_KEY=` tokens and aborts on hit.
- Stage 6 cleans the staging folder after the build (removes `config/`, `agent/`, `tools/` contents).

## Development

Run `pwsh -File build.ps1 -SyncOnly` (or `bun run build:sync`) to populate the staging folder without compiling. This is required for `bun run src/index.ts` development so the `with { type: "file" }` imports resolve.
