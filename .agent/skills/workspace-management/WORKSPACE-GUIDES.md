# Workspace Management Guides

High-level guidance for setting up and managing multi-repo agentic workspaces.

## When to Use Product/Dev Separation

Use product/dev separation when:
- Dev repo contains proprietary specs, sessions, evaluations, knowledge - not for public release
- Product repo contains shipped code, tests, config - safe for public release
- Workspace has multiple independent repos that need coordinated management

Do not use when:
- Single project with no separation between development artifacts and shipped code
- Monorepo where all content lives in one repository
- GENERAL workspace (no product code, no build infrastructure)

## How to Structure a Workspace

A WORKSPACE mode workspace has:

- DevRepo (workspace root) - contains .code-workspace file, specs, sessions, knowledge, SOPs, agent folder
- ProductRepo - contains shipped code, tests, config, product docs. Referenced in .code-workspace file
- CompanyRepo (optional) - central source folder for knowledge and specs shared across multiple workspaces

Detection: WORKSPACE mode is detected by presence of a `*.code-workspace` file in workspace root. The file is named after the workspace folder (e.g., `MyProject-Dev.code-workspace` for a folder named `MyProject-Dev`).

DevRepo structure:
- [folder-name].code-workspace (references ProductRepo and other repos)
- NOTES.md (workspace constants, project info, build/test rules)
- PROBLEMS.md, PROGRESS.md, ID-REGISTRY.md, SOPS.md, FAILS.md
- [AGENT_FOLDER]/ (rules, workflows, skills)
- knowledge/ (knowledge bundles)
- specs/ (shared specifications, design guidelines, SOPs)
- docs/ (explanatory knowledge documents)
- _sessions/ (session folders)

ProductRepo structure:
- README.md (from PRODUCT_REPO_README_TEMPLATE.md)
- src/ (source code)
- tests/ (test code)
- docs/ (product documentation)
- Optional: [product-agent-folder]/ (product-specific agent folder)

CompanyRepo structure:
- NOTES.md (from COMPANY_REPO_NOTES_TEMPLATE.md, tracks downstream repos and sync policies)
- knowledge/ (knowledge bundles shared to downstream repos)
- specs/ (specs bundles shared to downstream repos)

## How to Configure Sync Sources

Direction definitions:
- Downstream = sync from source to all targets (distribute content to dependent repos)
- Upstream = sync from here back to source (push local changes back to origin)

Three sync sources, each with downstream and upstream directions:

1. Prompt System
   - Source: PromptSystem source (latest PromptSystemV* folder)
   - Target: [AGENT_FOLDER] in DevRepo and/or ProductRepo
   - Content: rules, workflows, skills
   - Filter: include/exclude glob patterns per target entry in promptsystem-sync.json

2. Knowledge
   - Source: [KNOWLEDGE_SOURCE_FOLDER] (CompanyRepo)
   - Target: [KNOWLEDGE_FOLDER] (DevRepo)
   - Content: knowledge bundles (topic folders with reference documents)
   - Filter: include/exclude glob patterns per target entry

3. Specs
   - Source: [SPECS_SOURCE_FOLDER] (CompanyRepo)
   - Target: [SPECS_FOLDER] (DevRepo)
   - Content: specs, workflows, design guidelines, SOPs
   - Filter: include/exclude glob patterns per target entry

Sync config lookup:
1. promptsystem-sync.json at target [WORKSPACE_FOLDER] root (single source of truth)
2. No fallback - if promptsystem-sync.json is missing, repo is SELF-CONTAINED

promptsystem-sync.json structure:
- Top-level: `last_sync` (timestamp), `deprecated` (array, shared), `targets` (array)
- Each target entry: `path` (relative, e.g., `.devin`, `.claude`), `source` (relative path), `include`, `exclude`, `never_overwrite`
- No `bundles` or `selected_bundles` — include/exclude is the single filter layer

## How to Manage Knowledge Bundles

A knowledge bundle is a folder of reference documents for a specific topic (e.g., Devin/, AI-Standards/, OpenAI/).

To add a new knowledge bundle:
1. Create folder in [KNOWLEDGE_SOURCE_FOLDER] (CompanyRepo)
2. Add reference documents (.md files) to the folder
3. Update promptsystem-sync.json at target to include the new bundle in target `include` patterns
4. Run sync to distribute to downstream repos

To remove a knowledge bundle:
1. Remove from target `include` patterns in promptsystem-sync.json
2. Run sync - bundle will be marked for deletion in downstream repos
3. Confirm deletion during sync preview

Sub-bundles (nested folders) are supported (e.g., Devin/HowCascadeWorks/).

## [WORKSPACE_FOLDER] vs [WORKSPACE_FILE]

These two concepts are distinct and must not be conflated:

- **[WORKSPACE_FOLDER]**: The filesystem path of the workspace root directory. This is where the DevRepo lives. Example: `e:\Dev\MyProject`. All workspace constants are relative to this path.

- **[WORKSPACE_FILE]**: The `[folder-name].code-workspace` file inside [WORKSPACE_FOLDER], named after the workspace folder (e.g., `MyProject-Dev.code-workspace`). This JSON file defines which repos belong to the workspace by referencing their folder paths. Repos referenced in this file may be physically outside [WORKSPACE_FOLDER] (e.g., `../ProductRepo`). The file is the authority for multi-repo commit scope.

**Why the distinction matters:**
- Filtering repos by physical location inside [WORKSPACE_FOLDER] would incorrectly exclude ProductRepo and CompanyRepo in WORKSPACE mode, because they are typically siblings (`../ProductRepo`), not subdirectories
- The workspace file defines workspace membership, not the folder path
- In SINGLE-PROJECT and MONOREPO modes, there is no [WORKSPACE_FILE] - only [WORKSPACE_FOLDER] exists

**Detection:**
- [WORKSPACE_FOLDER] is always the current workspace root (where the agent operates)
- [WORKSPACE_FILE] exists only in WORKSPACE mode (detected by presence of a `*.code-workspace` file)

**Commit scope:**
- WORKSPACE mode: commit repos referenced in [WORKSPACE_FILE], regardless of physical location
- SINGLE-PROJECT/MONOREPO: commit only the repo at [WORKSPACE_FOLDER]
- Never commit linked repos or deploy targets unless [ACTOR] explicitly requests

## IDE Launcher Scripts

Each workspace gets `Devin.bat` and `DevinNext.bat` at workspace root to launch the IDE from Explorer.

Two variants based on workspace mode:

**Single-repo** (SINGLE-PROJECT, GENERAL) - opens the folder directly:
```bat
@echo off
set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
start "" "%LOCALAPPDATA%\Programs\Devin\Devin.exe" "%DIR%"
```

**Multi-repo** (WORKSPACE) - finds and opens the .code-workspace file:
```bat
@echo off
set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
for %%f in ("%DIR%\*.code-workspace") do (
    start "" "%LOCALAPPDATA%\Programs\Devin\Devin.exe" "%%f"
    exit /b
)
```

For `DevinNext.bat`, replace the exe path with `%LOCALAPPDATA%\Programs\Devin Next\Devin - Next.exe`.

These files are generated during `/workspace-setup create` and are workspace-mode-aware.

## When to Use Sync vs Self-Contained

A repo can be SYNCED or SELF-CONTAINED:

- **SYNCED**: Repo receives updates from upstream sources. Has promptsystem-sync.json at [WORKSPACE_FOLDER] root. Sync source constants ([COMPANY_REPO_FOLDER], [KNOWLEDGE_SOURCE_FOLDER], [SPECS_SOURCE_FOLDER]) are defined in NOTES.md.

- **SELF-CONTAINED**: Repo manages all content locally. No promptsystem-sync.json. No sync source constants in NOTES.md.

Use SELF-CONTAINED for:
- Standalone projects with no external dependencies
- Prototypes and experiments
- Repos with custom rules that don't need upstream sync

Use SYNCED for:
- Repos that receive PromptSystem updates from a central source
- Repos that share knowledge bundles from a Company folder
- Repos in a multi-workspace sync dependency tree

Switching from SELF-CONTAINED to SYNCED:
1. Add sync source constants to NOTES.md
2. Create promptsystem-sync.json at [WORKSPACE_FOLDER] root
3. Run `/sync workspace` to pull initial content

Switching from SYNCED to SELF-CONTAINED:
1. Remove sync source constants from NOTES.md
2. Delete or archive promptsystem-sync.json
3. Future syncs will not run (no config found)

## Quick Config

Always required workspace constants in DevRepo NOTES.md:

```
## Workspace Constants
- [WORKSPACE_FOLDER]: [current workspace root path]
- [WORKSPACE_FILE]: [WORKSPACE_FOLDER]\[folder-name].code-workspace (WORKSPACE mode only)
- [PRODUCT_REPO_FOLDER]: [WORKSPACE_FOLDER]\..\[product-repo-name]
- [DEV_KNOWLEDGE_FOLDER]: [WORKSPACE_FOLDER]\knowledge
- [DEV_SPECS_FOLDER]: [WORKSPACE_FOLDER]\specs
- [PRODUCT_DOCS_FOLDER]: [PRODUCT_REPO_FOLDER]\docs
- [AGENT_FOLDER]: [WORKSPACE_FOLDER]\[AGENT_FOLDER_NAME] (e.g., .devin, .claude)
- [SESSIONS_FOLDER]: [WORKSPACE_FOLDER]\_sessions
```

Required for SYNCED only (remove if SELF-CONTAINED):

```
- [COMPANY_REPO_FOLDER]: [WORKSPACE_FOLDER]\..\Company
- [KNOWLEDGE_SOURCE_FOLDER]: [COMPANY_REPO_FOLDER]\knowledge
- [SPECS_SOURCE_FOLDER]: [COMPANY_REPO_FOLDER]\specs
```

[WORKSPACE_FOLDER] is the filesystem path. [WORKSPACE_FILE] is the .code-workspace file (named after the workspace folder) that defines which repos belong to the workspace (WORKSPACE mode only). Repos in the workspace file may be outside [WORKSPACE_FOLDER].

## Workspace Mode Detection Logic

```
Workspace root
├─> Has src/ folder or build infrastructure (Build/Test, Runtime)?
│   ├─> Yes -> SOFTWARE-DEV (Dimension 5)
│   │   └─> Detect Dimension 1 (Project Structure):
│   │       ├─> *.code-workspace file exists?
│   │       │   ├─> Yes -> WORKSPACE mode
│   │       │   └─> No
│   │       │       ├─> Multiple project subfolders?
│   │       │       │   ├─> Yes -> MONOREPO mode
│   │       │       │   └─> No -> SINGLE-PROJECT mode
│   └─> No -> GENERAL (Dimension 5)
│       └─> Dimension 1 = N/A (single repo, no structure mode)
│       └─> Defaults to IMPL-ISOLATED (code only in session folders)
```

In WORKSPACE mode, version strategy (SINGLE-VERSION vs MULTI-VERSION) is detected per repo, not workspace-wide.
GENERAL mode: Dimension 1 and 2 = N/A. Defaults to IMPL-ISOLATED.

## Sync Flow

```
User runs /sync workspace
├─> Read promptsystem-sync.json from target [WORKSPACE_FOLDER] root
├─> For each source entry in config:
│   ├─> Run sync.ps1 -diff -sources <source> -targets <target> -configs promptsystem-sync.json
│   ├─> Show preview: new, modified, deleted, skipped files
│   └─> Show excluded files with -verbose (filtered by bundle include/exclude rules)
├─> Prompt user for confirmation
├─> If confirmed:
│   ├─> Run sync.ps1 -execute with same params
│   ├─> Verify last_sync timestamp updated in promptsystem-sync.json
│   └─> Summary: X added, Y modified, Z deleted, W skipped
└─> If not confirmed: abort, no changes made
```

## Verify Flow

```
User runs /verify workspace
├─> Read WORKSPACE-RULES.md from skill folder
├─> Detect sync relationship (SYNCED or SELF-CONTAINED)
├─> Read workspace constants from DevRepo NOTES.md
├─> Check required files per workspace type
├─> If SYNCED:
│   ├─> Check all required constants (base + sync source + WORKSPACE_FILE if applicable)
│   ├─> Check promptsystem-sync.json exists at [WORKSPACE_FOLDER] root
│   └─> Check source paths in promptsystem-sync.json resolve to valid paths
├─> If SELF-CONTAINED:
│   ├─> Check base constants only (skip sync source constants)
│   └─> Skip sync source constant checks
├─> Check agent folder structure (rules/, workflows/, skills/)
├─> Report gaps:
│   ├─> Missing constant -> add with template default
│   ├─> Missing required file -> create from template
│   ├─> Broken reference -> report only (requires user judgment)
│   └─> Structural violation -> report only
└─> Report all fixes with what changed and why
```

Downstream customizations are allowed and do not fail verification.
