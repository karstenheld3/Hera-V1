<!-- PROMPTSYSTEM SYNC PREVIEW TEMPLATE. Remove this comment after creating. -->
<!-- Instance naming: present in chat, not saved as file -->
<!-- Usage: Agent fills this template from sync.ps1 -diff output and presents in chat before -execute -->
<!-- Preview format is mandatory — do NOT hand-format. Use sync.ps1 -diff output to fill. -->

# Sync Preview: [SOURCE_PATH] to [N] target(s)

<!-- Source path is the `source` field from the first target entry in promptsystem-sync.json (e.g., ../IPPS/.devin). -->
<!-- N = number of target entries in promptsystem-sync.json `targets` array. -->

## Deprecated Files (from promptsystem-sync.json top-level)

<!-- List all entries from top-level `deprecated` array in promptsystem-sync.json. -->
<!-- These are deleted from ALL targets regardless of target include/exclude patterns. -->

- [deprecated_file_path_1]
- [deprecated_file_path_2]
<!-- Repeat for each deprecated file. -->

## Per-Target Preview

<!-- Repeat this block for EACH target entry. One block per target, never aggregate. -->
<!-- Use the `path` field from the target entry (relative, e.g., .devin). -->
<!-- Use Windows backslash paths in file listings. -->

[TARGET_PATH]
  - Add: [N] new files
      [folder]\[subfolder]\[file.ext]
      [folder]\[subfolder]\[file.ext]
  - Overwrite: [N] older files
      [folder]\[subfolder]\[file.ext]
  - Overwrite: [N] locally-modified files
      [folder]\[subfolder]\[file.ext]
  - Delete: [N] deprecated files
      [folder]\[subfolder]\[file.ext]
  - Skipped: [reason]
      [folder]\[subfolder]\[file.ext]
  - Excluded skills: [skill1, skill2]

<!-- Conditional: include Add block only when add count > 0. -->
<!-- Conditional: include Overwrite (older) block only when modify count > 0. -->
<!-- Conditional: include Overwrite (locally-modified) block only when locally_modified count > 0. -->
<!-- Conditional: include Delete block only when delete count > 0. -->
<!-- Conditional: include Skipped block only when skip count > 0. -->
<!-- Conditional: include Excluded skills block only when excluded count > 0. -->
<!-- Conditional: replace entire block with "[UP TO DATE] [N] files unchanged" when no changes. -->
<!-- Conditional: replace entire block with "[NEW REPO] [agent_folder] does not exist - will create with [N] files" when target folder missing. -->

## Summary

<!-- Aggregate counts across all targets. -->

[N] repos to process, [N] files to deploy, [N] files to delete.

<!-- EXAMPLE: Reference only. Do not copy into new documents. Shows a completed preview with 3 targets. -->

## Full Example

```markdown
# Sync Preview: ../IPPS/.devin to 3 target(s)

## Deprecated Files (from promptsystem-sync.json top-level)

- rules\devsystem-core.md
- rules\devsystem-ids.md
- workflows\workspace-create.md
- skills\workspace-management\WORKSPACE_CREATION_QUESTIONNAIRE.md

## Per-Target Preview

.devin
  - Add: 3 new files
      rules\promptsystem-core.md
      rules\promptsystem-ids.md
      skills\workspace-management\WORKSPACE_SETUP_QUESTIONNAIRE.md
  - Overwrite: 34 older files
      rules\agentic-english.md
      rules\core-conventions.md
      workflows\sync.md
      skills\workspace-management\sync.ps1
  - Overwrite: 2 locally-modified files
      NOTES.md
      workflows\commit.md
  - Delete: 2 deprecated files
      workflows\workspace-create.md
      skills\workspace-management\WORKSPACE_CREATION_QUESTIONNAIRE.md
  - Excluded skills: llm-transcription, youtube-downloader, travel-info

.devin
  - Add: 158 new files
      rules\agent-behavior.md
      rules\agentic-english.md
      rules\core-conventions.md
      workflows\bugfix.md
      workflows\cleanup.md
      skills\coding-conventions\SKILL.md
      skills\coding-conventions\PYTHON-RULES.md
  - Excluded skills: llm-transcription, youtube-downloader, travel-info, hosting, seo-tools, pdf-tools, image-tools, google-account, llm-computer-use, llm-evaluation, ms-playwright-mcp, playwriter-mcp, windows-desktop-control, devin-auto-model-switcher

.devin
  [UP TO DATE] 287 files unchanged

## Summary

3 repos to process, 160 files to deploy, 2 files to delete.
```
