---
trigger: always_on
---

# Tools and Skills

Tool-specific knowledge and disambiguation.

## Browser Automation (Playwright vs Playwriter)

**These are different tools with confusingly similar names:**

- **Playwright MCP** (default) - Microsoft's MCP server. Spawns fresh browser instance. `npx @playwright/mcp@latest`
- **Playwriter** (exception) - Chrome extension + CLI. Uses your **real browser** with existing logins/cookies. Install from `playwriter.dev`

**When to use:**
- **Playwright MCP**: Default choice. Clean sessions, standard automation, no existing auth needed
- **Playwriter**: When explicitly asked for by user using `Playwriter` term

## Workflow-First Rule

Before executing any multi-step operation (file processing, deployment, transcription, email):

1. Search `[WORKFLOWS]` for applicable workflow: file type, action verb, or domain
2. Search `[SKILLS]` for applicable skill
3. **If workflow/skill exists**: MUST follow it step-by-step. No improvisation, no shortcuts.
4. **If not found**: Proceed with best judgment

Before installing Python or PowerShell modules: Check existing skills and workflows for established dependencies, venvs, and tool preferences first.

Violation = automatic CRITICAL in FAILS.md. No exceptions.

## Skill Registry

Skills are in `[AGENT_FOLDER]/skills/`. Each has a `SKILL.md` with usage instructions. The agent MUST discover available skills by listing the `[AGENT_FOLDER]/skills/` directory and reading each `SKILL.md` frontmatter `description` field. Do not rely on a hardcoded list - skills may be added, removed, or customized per workspace.

## Tool Locations

Executable tools outside the workspace:

- **Python venv**: `[WORKSPACE_FOLDER]/../.tools/llm-venv/Scripts/python.exe`
- **API keys**: `[WORKSPACE_FOLDER]/../.tools/.api-keys.txt` (default; override in session or workspace NOTES.md)
- **Poppler** (PDF): `[WORKSPACE_FOLDER]/../.tools/poppler/Library/bin/`
- **Ghostscript**: `[WORKSPACE_FOLDER]/../.tools/gs/bin/`
- **QPDF**: `[WORKSPACE_FOLDER]/../.tools/qpdf/bin/`
- **7-Zip**: `[WORKSPACE_FOLDER]/../.tools/7z/`
- **ImageMagick**: `[WORKSPACE_FOLDER]/../.tools/magick/`
- **gogcli config**: `[WORKSPACE_FOLDER]/../.tools/gogcli-client-secret.json`
