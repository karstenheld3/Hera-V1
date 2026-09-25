<!-- DEV_REPO_NOTES TEMPLATE. Remove this comment after creating. -->

# NOTES

## MUST-NOT-FORGET

- [PROMPTSYSTEM_FOLDER] is the source of truth. Never edit [AGENT_FOLDER] directly
- Sync order: 1) [PROMPTSYSTEM_FOLDER] → [AGENT_FOLDER] (robocopy /MIR), 2) [AGENT_FOLDER] → [LINKED_REPOS] (sync.ps1 -execute). Stage 2 requires stage 1 complete. Stage 3 (linked repo local mirror) is NOT automatic from source repo
- Downstream repos pull from [AGENT_FOLDER], NOT from [PROMPTSYSTEM_FOLDER]. The local mirror is the published source for linked repos
- Use placeholders in all workspace/session files, never ephemeral version strings or repo names

## Table of Contents

- [MUST-NOT-FORGET](#must-not-forget)
- [Project Info](#project-info)
- [Workspace Constants](#workspace-constants)
- [Sync Sources](#sync-sources)
- [Prevention Rules](#prevention-rules-from-session-fails)
- [Full Stack and Dependencies](#full-stack-and-dependencies)
- [Build/Test Rules](#buildtest-rules)
- [Scripts](#scripts)
- [Runtime Environment](#runtime-environment)
- [Architecture Decisions](#architecture-decisions)
- [Source Control](#source-control)
- [Agent Safety Rules](#agent-safety-rules)
- [Key References](#key-references)
- [Knowledge Map](#knowledge-map)
- [Docs Map](#docs-map)
- [Specs Map](#specs-map)
- [Release Configuration](#release-configuration)

## Project Info

- Project name: [project-name]
- Project goal: [one-sentence-description]
- Workspace type: [SOFTWARE-DEV|GENERAL]
- Workspace mode: [SINGLE-PROJECT|MONOREPO|WORKSPACE] (omit if GENERAL)
- Version strategy: [SINGLE-VERSION|MULTI-VERSION] (omit if GENERAL)

<!-- Instructions: Replace placeholder values with your project information. -->

## Workspace Constants

[WORKSPACE_FOLDER]: `[current workspace root path]`
- Root folder of the workspace. All other paths compose from this.

[WORKSPACE_FILE]: `[WORKSPACE_FOLDER]\[folder-name].code-workspace`
- WORKSPACE mode only. Named after workspace folder (e.g., `MyProject-Dev.code-workspace`). Omit if SINGLE-PROJECT or MONOREPO.

<!-- Conditional: Omit the following constants for GENERAL workspaces (WS-CT-09). -->

[PRODUCT_REPO_FOLDER]: `[WORKSPACE_FOLDER]\..\[product-repo-name]`
- Product repository folder. In SINGLE-PROJECT mode, equals [WORKSPACE_FOLDER]. In WORKSPACE mode, may be outside [WORKSPACE_FOLDER].

[PRODUCT_SOURCE_FOLDER]: `[PRODUCT_REPO_FOLDER]\src`
- Source code folder. Applies to ProductRepo only.

[PRODUCT_DOCS_FOLDER]: `[PRODUCT_REPO_FOLDER]\docs`
- Product documentation folder.

[PRODUCT_VERSION]: `X.Y`
- Current product version. Format: `X.Y`, `X.Y.Z`, or `YYYY-MM-DD`. Used to compose version-dependent folder names and for release version extraction.

[DEV_KNOWLEDGE_FOLDER]: `[WORKSPACE_FOLDER]\knowledge`
- Knowledge bundles folder (synced from upstream in SYNCED repos).

[DEV_SPECS_FOLDER]: `[WORKSPACE_FOLDER]\specs`
- Specs folder containing shared specifications, design guidelines, SOPs.

[AGENT_FOLDER]: `[WORKSPACE_FOLDER]\[AGENT_FOLDER_NAME]` (e.g., .devin, .claude)
- Agent config folder. Sync target — copy of PromptSystem source content.

[SESSIONS_FOLDER]: `[WORKSPACE_FOLDER]\_PrivateSessions_gitignore`
- Base folder for session folders.

[SESSION_ARCHIVE_FOLDER]: `[SESSIONS_FOLDER]\..\Archive`
- Archive folder for closed sessions.

[SKILL_TOOLS_FOLDER]: `[WORKSPACE_FOLDER]\..\.tools\`
- Command line tools used by various PromptSystem skills. Shared across workspaces.

[API_KEYS_FILE]: `[SKILL_TOOLS_FOLDER]\.api-keys.txt`
- API keys file for skill scripts. Pass via `--keys-file [API_KEYS_FILE]`.

<!-- Conditional: Required for SYNCED only. Remove if SELF-CONTAINED. -->

[COMPANY_REPO_FOLDER]: `[WORKSPACE_FOLDER]\..\Company`
- Company repository folder (upstream source for knowledge and specs).

[KNOWLEDGE_SOURCE_FOLDER]: `[COMPANY_REPO_FOLDER]\knowledge`
- Upstream knowledge source. Sync target is [DEV_KNOWLEDGE_FOLDER].

[SPECS_SOURCE_FOLDER]: `[COMPANY_REPO_FOLDER]\specs`
- Upstream specs source. Sync target is [DEV_SPECS_FOLDER].

<!-- Release constants: Required for /project-release workflow. -->

[SOPS_FILE]: `SOPS.md`
- SOPS filename in workspace root.

[RELEASE_NOTES_FOLDER]: `[PRODUCT_DOCS_FOLDER]\ReleaseNotes`
- Release notes directory. Naming: `RELEASE_NOTES_v{VERSION}_{DATE}.md`.

<!-- Instructions:
- Replace [product-repo-name] with your product repository folder name
- Adjust [COMPANY_REPO_FOLDER] if your company folder is in a different location
- All paths should be relative to [WORKSPACE_FOLDER]
- [WORKSPACE_FILE] is the .code-workspace file (named after workspace folder) that defines which repos belong to the workspace
- Repos referenced in it may be physically outside [WORKSPACE_FOLDER] (e.g., ../ProductRepo)
- Omit [WORKSPACE_FILE] in SINGLE-PROJECT and MONOREPO modes
- Remove the SYNCED-only constants if your repo is SELF-CONTAINED (no external sync sources)
- [PROMPTSYSTEM_FOLDER] is repo-specific — compose as [WORKSPACE_FOLDER]\PromptSystem[PRODUCT_VERSION] in NOTES.md -->

<!-- Conditional: Remove this entire section if SELF-CONTAINED (no external sync sources). -->

## Sync Sources

### How Syncing Works

Sync configuration lives in `promptsystem-sync.json` at `[WORKSPACE_FOLDER]` root (PULL model). This file defines:
- **targets** array: each entry is self-contained (path, source, include, exclude, never_overwrite)
- **deprecated**: top-level array (shared across all targets in repo)
- Source is purely a content provider — no config at source

The `sync.ps1` script in `@skills:workspace-management` performs the actual sync. Always preview with `-diff` before executing.

### Sync Order (3 stages)

1. **[PROMPTSYSTEM_FOLDER] → local [AGENT_FOLDER]** — robocopy /MIR (after every edit to source)
2. **[AGENT_FOLDER] → [LINKED_REPOS]** — sync.ps1 -execute at each target (explicit user confirmation only). Source for targets: `../[source-repo]/[AGENT_FOLDER]`
3. **[LINKED_REPOS] local mirror** — robocopy /MIR at each linked repo (NOT automatic from source repo)

### Usage Examples

Preview changes (no files modified):
```powershell
& sync.ps1 -diff -config "promptsystem-sync.json"
```

Apply changes (copies, overwrites, deletes deprecated files):
```powershell
& sync.ps1 -execute -config "promptsystem-sync.json"
```

Or use the `/sync` workflow which wraps these commands.

<!-- Instructions:
- Adjust source paths in promptsystem-sync.json if your PromptSystem source is in a different location
- All include/exclude, deprecated, and never_overwrite patterns are defined in promptsystem-sync.json
- See WSKMGMT-SP01 section 10 for the JSON schema -->

## Prevention Rules (from session fails)

<!-- Instructions: Add project-specific prevention rules here. These are lessons learned from session failures that must be applied going forward. Each rule has a bold label and a one-line description. -->

- **No Ask Tool**: NEVER use the `ask_user_question` tool. Resolve ambiguity through prompt analysis, not interactive prompts. See `agent-behavior.md` Attitude section.

<!-- Conditional: Omit Build/Test, Runtime Environment, and Release Configuration for GENERAL workspaces (WS-CT-09). -->

## Build/Test Rules

- Build command: [build-command]
- Test command: [test-command]
- Lint command: [lint-command]

<!-- Instructions: Define commands for building, testing, and linting your product repo. -->

<!-- Conditional: Applies to ProductRepo only. DevRepo and CompanyRepo are exempt (no buildable source code). -->

## Scripts

<!-- Instructions: List all build, test, deploy, and utility scripts. Include batch file wrappers and what they do. Omit section if no scripts. -->

**Build/Compile:**
- `[script-name].bat` — [description]

**Test:**
- `[script-name].bat` — [description]

**Deploy:**
- `[script-name].bat` — [description]

**Configuration:**
- `[script-name].bat` — [description]

## Runtime Environment

- Runtime: [node|bun|deno|python|rust|zig]
- Version file: [.nvmrc|.python-version|rust-toolchain.toml|build.zig.zon]
- Environment dir: [node_modules|.venv|target|zig-cache]
- Activate command: [n/a for rust/zig|.venv\Scripts\activate for python|fnm use for node]

<!-- Instructions:
- Every ProductRepo must use a local environment
- See LOCAL_ENVIRONMENTS.md in workspace-management skill for setup details
- Pin runtime version in a committed version file
- Gitignore the environment directory -->

<!-- Conditional: Omit for GENERAL workspaces. -->

## Full Stack and Dependencies

<!-- Instructions: List the full technology stack, key dependencies, and lock files. Omit section if no product code. -->

**Stack:**
- Language: [language]
- Framework: [framework]
- Runtime: [runtime]
- Package manager: [npm|bun|pip|uv|cargo]

**Key Dependencies:**
- `[package-name]` — [purpose]

**Lock file:** [package-lock.json|requirements.txt|Cargo.lock]
**Dependency install command:** [command]
**Dependency update command:** [command]

## Architecture Decisions

<!-- Instructions: Record key architecture and design decisions. Include date and rationale. Omit section if no significant decisions. -->

- **[Decision title]** ([date]): [decision and rationale]

## Source Control

<!-- Instructions: Document what is tracked vs gitignored, git conventions, and any special gitignore patterns. Omit section if standard git workflow. -->

**Tracked in git:**
- [what is tracked]

**Gitignored:**
- [what is gitignored and why]

**Git conventions:**
- `_gitignore` suffix: Append `_gitignore` before extension to exclude files/folders from git without editing `.gitignore`. Patterns `*_gitignore.*` and `*_gitignore/` already in `.gitignore`.
- [any other conventions]

## Agent Safety Rules

<!-- Instructions: Rules to prevent agent from causing harm. Add project-specific safety rules. Omit section if none. -->

- **NEVER** [specific unsafe action]
- **Safe alternative**: [safe approach]

## Key References

<!-- Instructions: List important reference files the agent should read for context. Omit section if none. -->

- `[path/to/file]` — [what it contains]

## Knowledge Map

<!-- Instructions: For repos with a knowledge/ folder, describe the local reference structure. Omit section if no knowledge folder. -->

Local research base under `[DEV_KNOWLEDGE_FOLDER]`.

**[Topic area]:**
- `[folder/path]` — [description, topic count, key files]

## Docs Map

<!-- Instructions: For repos with a docs/ folder, describe the local documentation structure. Omit section if no docs folder. -->

Local documentation under `[WORKSPACE_FOLDER]\docs`.

**[Document type]:**
- `[path/to/file]` — [description, purpose, key content]

## Specs Map

<!-- Instructions: For repos with a specs/ folder, describe the local specs structure. Omit section if no specs folder. -->

Local specs under `[DEV_SPECS_FOLDER]`.

**[Spec type]:**
- `[path/to/file]` — [description, Doc ID, status]

## Release Configuration

<!-- Instructions:
- Configure for /project-release workflow
- All paths use workspace constants from ## Workspace Constants section above
- See _SPEC_RELEASE_PROJECT_WORKFLOW.md [RLSPROJ-SP01] for full config schema and decision guide -->

```
[RELEASE_CONFIG]
sops_file: [SOPS_FILE]
sessions_folder: [SESSIONS_FOLDER]
release_notes_dir: [RELEASE_NOTES_FOLDER]
release_notes_naming: RELEASE_NOTES_v{VERSION}_{DATE}.md
tag_annotation_template: Release {TAG}: {SUMMARY}
# github_release_confirm: false  # Uncomment to create GitHub releases without the y/n question (default true)

# Single-repo: one [RELEASE_REPO] block
# Multi-repo: product block first, then dev block(s)

[RELEASE_REPO: product]
path: [WORKSPACE_FOLDER]
role: product
tag_format: [date or semver]
version_source: [promptsystem_folder or pyproject_toml or package_json or none]
# version_file: [PRODUCT_REPO_FOLDER]\pyproject.toml  # Required when version_source is pyproject_toml or package_json
post_release_bump: [promptsystem_rename or patch_bump or minor_bump or none]
# binary_build: true     # Uncomment if product has a binary
# binary_path_pattern: dist/[appname]-{version}-win-x64.exe  # Required when binary_build is true
# version_gate: true     # Uncomment if version consistency check needed
# test_command: [command]  # Uncomment if tests not already defined in ## Build/Test Rules
github_release: true
# github_release_assets:  # Uncomment if binary assets to attach
#   - dist/[appname]-{version}-win-x64.exe

# [RELEASE_REPO: dev]    # Uncomment for multi-repo
# path: [WORKSPACE_FOLDER]
# role: dev
# tag_format: [date or semver]
# version_source: [promptsystem_folder or pyproject_toml or package_json or none]
# post_release_bump: [promptsystem_rename or patch_bump or minor_bump or none]
# test_command: [command]
# github_release: true
# github_release_notes: reference  # Dev repo references product release
```

<!-- Instructions:
- Replace placeholder values
- test_command lookup order: (1) [RELEASE_REPO] config, (2) ## Build/Test Rules section above, (3) skip
- If test_command already defined in Build/Test Rules, omit it from [RELEASE_REPO] config -->
