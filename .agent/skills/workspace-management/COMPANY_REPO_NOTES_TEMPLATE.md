# CompanyRepo NOTES Template

Template for CompanyRepo NOTES.md. Copy and adapt for your company repository.

Replace all `[placeholder]` values with your organization-specific content.

## MUST-NOT-FORGET

- [PROMPTSYSTEM_FOLDER] is the source of truth. Never edit [AGENT_FOLDER] directly
- Sync order: 1) [PROMPTSYSTEM_FOLDER] → [AGENT_FOLDER] (robocopy /MIR), 2) [AGENT_FOLDER] → [LINKED_REPOS] (sync.ps1 -execute). Stage 2 requires stage 1 complete. Stage 3 (linked repo local mirror) is NOT automatic from source repo
- Downstream repos pull from [AGENT_FOLDER], NOT from [PROMPTSYSTEM_FOLDER]. The local mirror is the published source for linked repos
- Use placeholders in all workspace/session files, never ephemeral version strings or repo names

## Table of Contents

- [MUST-NOT-FORGET](#must-not-forget)
- [Company Info](#company-info)
- [Downstream Repositories](#downstream-repositories)
- [Source Content](#source-content)

## Company Info

- Company folder: [COMPANY_REPO_FOLDER]
- Description: [one-sentence-description]
- Maintainer: [role-or-team]

## Downstream Repositories

This section is informational only. Each downstream repo owns its own sync configuration in `promptsystem-sync.json` at its `[WORKSPACE_FOLDER]` root. The source repo does NOT contain sync configuration.

### [downstream-repo-1]

- Repo path: ../[downstream-repo-1] (relative path only)
- Sync sources used: Prompt System, Knowledge, Specs
- Include patterns: [patterns]
- Exclude patterns: [patterns]
- PromptSystem version: PromptSystemV[X.Y]

### [downstream-repo-2]

- Repo path: ../[downstream-repo-2] (relative path only)
- Sync sources used: Prompt System, Knowledge
- Include patterns: [patterns]
- Exclude patterns: [patterns]
- PromptSystem version: PromptSystemV[X.Y]

Instructions: Add one section per downstream repo. Use RELATIVE paths only (e.g., `../MyProject`), never absolute paths. This list is informational — it helps `/sync to targets` workflows know which repos to push to. The actual sync configuration (include, exclude, never_overwrite, deprecated) lives in each target repo's `promptsystem-sync.json` `targets` array.

## Source Content

### Knowledge Folders

Folders in `[COMPANY_REPO_FOLDER]\knowledge\` available for sync:

- [folder-1]/ - [description]
- [folder-2]/ - [description]
- [folder-3]/ - [description]

### Specs Folders

Folders in `[COMPANY_REPO_FOLDER]\specs\` available for sync:

- [folder-1]/ - [description]

Instructions: List available knowledge and specs folders that downstream repos can include in their `promptsystem-sync.json` `targets` array. Add or remove folders as content evolves.
