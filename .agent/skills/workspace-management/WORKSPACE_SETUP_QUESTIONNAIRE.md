# Workspace Creation Guide

Interactive questionnaire for creating new single-repo and multi-repo workspaces. Agent presents questions to user, collects answers, then generates workspace files from templates.

## Table of Contents

- [How to Use](#how-to-use)
- [Section 1: Workspace Type and Mode](#section-1-workspace-type-and-mode)
- [Section 2: Product Repo](#section-2-product-repo)
- [Section 3: Dev Repo / Workspace Root](#section-3-dev-repo--workspace-root)
- [Section 4: Version Strategy](#section-4-version-strategy)
- [Section 5: Sync Sources](#section-5-sync-sources)
- [Section 6: Release Configuration](#section-6-release-configuration)
- [Section 7: Skill Categories](#section-7-skill-categories)
- [Output: Files to Generate](#output-files-to-generate)
- [Setup Schema](#setup-schema)

## How to Use

1. Present questions to user one section at a time
2. Show defaults in brackets — user can accept default by saying "yes" or provide own value
3. After each section, summarize what will be created and the impact
4. After all sections answered, generate files from templates and report results

## Section 1: Workspace Type and Mode

```
Question 1a: What workspace type do you need?

1) SOFTWARE-DEV - Software development workspace
   Impact: Has product repo, build/test rules, runtime environment, release
   configuration. Mode selection (SINGLE-PROJECT, MONOREPO, WORKSPACE) required.
   Examples: CLI tool workspace, web app dev+product split

2) GENERAL - General-purpose workspace, no product code or build infrastructure
   Impact: Single git repo. No product repo, no src/ folder, no Build/Test,
   no Runtime Environment, no Release Configuration. Code allowed only in
   session folders (POCs, analysis scripts). Defaults to IMPL-ISOLATED.
   Use for research, documentation, tax/finance, or any non-software workspace.
   Examples: research workspace, documentation hub, finance tracking workspace

Default: [1] SOFTWARE-DEV
```

```
Question 1b: What workspace mode do you need? (SOFTWARE-DEV only)

1) SINGLE-PROJECT - One repo with everything (code, specs, sessions, knowledge)
   Impact: Single git repo. No .code-workspace file. Agent folder, sessions,
   knowledge, SOPs all in one folder. Simplest setup.

2) WORKSPACE - Dev repo + product repo, separate git repos
   Impact: Two git repos. .code-workspace file links them. Dev repo has specs,
   sessions, knowledge, SOPs. Product repo has shipped code, tests, docs.
   Keeps proprietary IP out of product repo. More setup but better separation.

Default: [1] SINGLE-PROJECT
```

<!-- If user selects GENERAL, skip Section 2 (Product Repo), Section 4 (Version Strategy),
     and Section 6 (Release Configuration).
     If user selects SOFTWARE-DEV + SINGLE-PROJECT, skip Section 2 (Product Repo) and Section 5 (Sync Sources).
     If user selects SOFTWARE-DEV + WORKSPACE, all sections apply. If Section 5 answer is SELF-CONTAINED,
     skip questions 5b through 5h and omit sync source constants from NOTES.md. -->

## Section 2: Product Repo

<!-- Conditional: WORKSPACE mode only. -->

```
Questions for WORKSPACE mode:

2a) Product repo folder name: [myapp]
    Impact: Creates folder at [WORKSPACE_FOLDER]\..\[myapp]. This is where 
    your source code, tests, and product docs will live. Has its own git repo.

2b) Product repo description (one sentence): [A CLI tool for ...]
    Impact: Used in ProductRepo README.md and GitHub repo description.

2c) Does the product have a binary build? [yes/no]
    Default: [no]
    Impact: If yes, release workflow will ask user to build before tagging.
    Binary path pattern needed for version consistency gate.

2d) If yes, binary path pattern: dist/[appname]-{version}-win-x64.exe
    Impact: Release workflow verifies this file exists after user builds.
    {version} is replaced with the version from version source at release time.
```

## Section 3: Dev Repo / Workspace Root

```
3a) Project name: [myapp]
    Impact: Used in NOTES.md Project section, folder names, and release notes.
    In SINGLE-PROJECT mode, this is the only repo name.

3b) Project goal (one sentence): [Describe what this project does]
    Impact: Recorded in NOTES.md. Guides agent context and release notes.

3c) Agent folder name: [.devin or .claude - per agent]
    Default: [.devin for Devin, .claude for Claude Code]
    Impact: Folder where rules, workflows, skills are synced from PromptSystem source.
    Some projects use a custom name (e.g., .lana) for product-bundled prompt systems.

3d) Sessions folder name: [_sessions]
    Default: [_sessions]
    Impact: Where /session-new creates session folders. Lowercase with underscore prefix.

3e) SOPS file name: [SOPS.md] or [_SOPS.md]
    Default: [SOPS.md]
    Impact: Standard Operating Procedures file. Underscore prefix sorts it 
    to top of file listing. Release workflow reads this file name from config.
```

## Section 4: Version Strategy

```
4a) Version source: 
    1) promptsystem_folder - Version from PromptSystemVX.Y folder name
       Impact: Version parsed from "[PRODUCT_VERSION]: X.Y" in NOTES.md.
       Post-release bump renames the folder. Use for PromptSystem development repos.
    
    2) pyproject_toml - Version from pyproject.toml
       Impact: Version parsed from version = "X.Y.Z" in pyproject.toml.
       Post-release bump increments patch/minor in the file. Use for Python projects.
    
    3) package_json - Version from package.json
       Impact: Version parsed from "version": "X.Y.Z" in package.json.
       Post-release bump increments patch/minor in the file. Use for Node.js projects.
    
    4) none - No version tracking
       Impact: Tags are the only version identifier. No post-release bump.
       Use for documentation-only or non-versioned repos.
    
    Default: [1] promptsystem_folder (SINGLE-PROJECT), [2] pyproject_toml (WORKSPACE with Python product)

4b) Tag format:
    1) date - YYYY-MM-DD tags (e.g., 2026-09-05)
       Impact: One tag per day maximum. Simple. No version number management.
       Good for PromptSystem repos, documentation repos, internal tools.
    
    2) semver - vX.Y.Z tags (e.g., v1.0.1)
       Impact: Version must be bumped before each release. Enables version 
       consistency gate for binary builds. Good for shipped products.
    
    Default: [1] date (SINGLE-PROJECT), [2] semver (WORKSPACE with binary build)

4c) Post-release bump strategy:
    1) promptsystem_rename - Rename PromptSystemVX.Y to PromptSystemVX.Y+1
       Impact: Folder rename + NOTES.md update + sync to [AGENT_FOLDER]/. 
       Only valid with promptsystem_folder version source.
    
    2) patch_bump - Increment patch (X.Y.Z -> X.Y.Z+1)
       Impact: Edit version file, commit, push. Only valid with file-based version source.
    
    3) minor_bump - Increment minor (X.Y.Z -> X.Y+1.0)
       Impact: Edit version file, commit, push. Only valid with file-based version source.
    
    4) none - No bump
       Impact: Working version stays at released version. Use for dev repos 
       that don't need independent versioning.
    
    Default: [1] promptsystem_rename (promptsystem_folder), [2] patch_bump (file-based)
```

## Section 5: Sync Sources

<!-- Conditional: WORKSPACE mode only. -->

```
Questions for WORKSPACE mode:

5a) Sync relationship: SYNCED or SELF-CONTAINED?
    1) SYNCED - Repo receives updates from upstream sources
       Impact: Creates promptsystem-sync.json at [WORKSPACE_FOLDER] root.
       Sync source constants defined in NOTES.md. /sync workspace distributes
       content from source repos. Use for repos in a multi-workspace sync tree.

    2) SELF-CONTAINED - Repo manages all content locally
       Impact: No promptsystem-sync.json. No sync source constants in NOTES.md.
       Use for standalone projects, prototypes, or repos with custom content
       that does not need upstream sync.

    Default: [1] SYNCED

5b) PromptSystem source path: [WORKSPACE_FOLDER]\..\[promptsystem-source-name]\PromptSystemV*
    Default: [WORKSPACE_FOLDER]\..\IPPS\PromptSystemV*
    Impact: Where rules, workflows, skills are synced FROM. Agent folder
    (agent folder, e.g., .devin) is the sync TARGET. /sync workspace updates agent folder
    from this source. Configured as a source entry in promptsystem-sync.json.
    Skip if SELF-CONTAINED.

5c) Company folder path: [WORKSPACE_FOLDER]\..\Company
    Default: [WORKSPACE_FOLDER]\..\Company
    Impact: Central source for knowledge and specs bundles. Shared across
    multiple workspaces. /sync workspace distributes content from here
    to downstream repos. Skip if SELF-CONTAINED.

5d) Knowledge folder: [WORKSPACE_FOLDER]\knowledge
    Default: [WORKSPACE_FOLDER]\knowledge
    Impact: Where reference documents are stored in dev repo. Synced from
    Company knowledge folder via promptsystem-sync.json targets configuration.
    Created as empty folder during workspace generation.

5e) Specs folder: [WORKSPACE_FOLDER]\specs
    Default: [WORKSPACE_FOLDER]\specs
    Impact: Where shared specs, design guidelines, and SOPs are stored in
    dev repo. Synced from Company specs folder via promptsystem-sync.json
    targets configuration. Created as empty folder during workspace generation.
    Replaces the former 'rules' folder.

5f) Knowledge include patterns:
    Default: ["*"] (all knowledge folders)
    Impact: Glob patterns for knowledge content to sync to this repo.
    Configured in promptsystem-sync.json targets array include field.
    Skip if SELF-CONTAINED.

5g) Specs include patterns:
    Default: ["*"] (all specs folders)
    Impact: Glob patterns for specs content to sync to this repo.
    Configured in promptsystem-sync.json targets array include field.
    Skip if SELF-CONTAINED.

5h) Files to protect from overwrite (never_overwrite):
    Default: ["NOTES.md", "!NOTES.md", "PROBLEMS.md", "!PROGRESS.md", "FAILS.md", "ID-REGISTRY.md", "SOPS.md", "_SOPS.md", "promptsystem-sync.json"]
    Impact: Glob patterns for files that sync.ps1 will never overwrite or
    delete, even if source has newer versions or files are deprecated.
    Protects workspace-specific customizations. Configured in
    promptsystem-sync.json never_overwrite array. Skip if SELF-CONTAINED.
```

## Section 6: Release Configuration

```
6a) Create GitHub releases? [yes/no]
    Default: [yes]
    Impact: After tagging, workflow asks user to confirm GitHub release creation.
    Requires gh CLI installed and authenticated. If no, tags are pushed but 
    no GitHub release is created.

6b) Release notes directory: [PRODUCT_DOCS_FOLDER]\ReleaseNotes
    Default: [PRODUCT_DOCS_FOLDER]\ReleaseNotes (WORKSPACE) or [WORKSPACE_FOLDER]\Docs\ReleaseNotes (SINGLE-PROJECT)
    Impact: Where generated release notes files are stored. One file per release.

6c) Run tests before release? [yes/no]
    Default: [yes]
    Impact: If yes, provide test command. Workflow runs tests before generating 
    release notes. If tests fail, release halts.

6d) If yes, test command: [command]
    Default: [from ## Build/Test Rules section in NOTES.md]
    Impact: Command executed in repo root before release. If already defined 
    in Build/Test Rules, leave blank to use that.

6e) Version consistency gate? [yes/no]
    Default: [yes] if binary_build is yes, [no] otherwise
    Impact: Verifies version alignment: version source, binary filename, 
    binary --version output, and git tag must all match. Halts on mismatch.
    Only meaningful with binary build and semver tags.
```

## Section 7: Skill Categories

<!-- Removed: Skills are discovered by scanning skills/ folder at startup. Sync selection
     is controlled by promptsystem-sync.json targets array include/exclude. No manual skill category list needed. -->

## Output: Files to Generate

After all sections answered, generate these files:

### SINGLE-PROJECT Mode

```
[WORKSPACE_FOLDER]\
  NOTES.md                    <- from DEV_REPO_NOTES_TEMPLATE.md (adapted)
  PROBLEMS.md                 <- empty tracking file
  PROGRESS.md                 <- empty tracking file
  ID-REGISTRY.md              <- from ID-REGISTRY_TEMPLATE.md (with project topic)
  SOPS.md                     <- from SOPS template or minimal
  FAILS.md                    <- empty tracking file
  _WORKSPACE_SETUP_QUESTIONNAIRE.md <- questionnaire for remaining sections
  Devin.bat                   <- IDE launcher (single-repo variant)
  DevinNext.bat               <- IDE launcher Next (single-repo variant)
  [AGENT_FOLDER]\             <- sync from PromptSystem source
    rules\
    workflows\
    skills\
  specs\                      <- empty folder (verifiable agent instructions)
  docs\                       <- empty folder (explanatory knowledge)
  docs\ReleaseNotes\          <- empty folder (if release configured)
  _sessions\                 <- empty folder
  _sessions\_archive\        <- empty folder (session archive)
```

### GENERAL Mode

```
[WORKSPACE_FOLDER]\
  NOTES.md                    <- from DEV_REPO_NOTES_TEMPLATE.md (adapted, no dev-only sections)
  PROBLEMS.md                 <- empty tracking file
  PROGRESS.md                 <- empty tracking file
  ID-REGISTRY.md              <- from ID-REGISTRY_TEMPLATE.md (with project topic)
  SOPS.md                     <- from SOPS template or minimal
  FAILS.md                    <- empty tracking file
  _WORKSPACE_SETUP_QUESTIONNAIRE.md <- questionnaire for remaining sections
  Devin.bat                   <- IDE launcher (single-repo variant)
  DevinNext.bat               <- IDE launcher Next (single-repo variant)
  [AGENT_FOLDER]\             <- sync from PromptSystem source
    rules\
    workflows\
    skills\
  specs\                      <- empty folder (verifiable agent instructions)
  docs\                       <- empty folder (explanatory knowledge)
  _sessions\                 <- empty folder
  _sessions\_archive\        <- empty folder (session archive)
```

<!-- GENERAL mode: No product repo, no src/ folder, no docs/ReleaseNotes/.
     NOTES.md omits [PRODUCT_REPO_FOLDER], [PRODUCT_SOURCE_FOLDER], [PRODUCT_DOCS_FOLDER],
     [PRODUCT_VERSION], [SOPS_FILE], [RELEASE_NOTES_FOLDER], Build/Test Rules,
     Runtime Environment, and Release Configuration sections. -->

### WORKSPACE Mode

```
[WORKSPACE_FOLDER]\
  [folder-name].code-workspace  <- references product repo (named after workspace folder)
  !NOTES.md                   <- from DEV_REPO_NOTES_TEMPLATE.md (adapted)
  !PROBLEMS.md                <- empty tracking file
  !PROGRESS.md                <- empty tracking file
  ID-REGISTRY.md              <- from ID-REGISTRY_TEMPLATE.md (with project topic)
  _SOPS.md                    <- from SOPS template or minimal
  FAILS.md                    <- empty tracking file
  _WORKSPACE_SETUP_QUESTIONNAIRE.md <- questionnaire for remaining sections
  Devin.bat                   <- IDE launcher (multi-repo variant)
  DevinNext.bat               <- IDE launcher Next (multi-repo variant)
  [AGENT_FOLDER]\             <- sync from PromptSystem source
    rules\
    workflows\
    skills\
  knowledge\                  <- empty folder
  specs\                      <- empty folder (verifiable agent instructions)
  docs\                       <- empty folder (explanatory knowledge)
  _sessions\                 <- empty folder
  _sessions\_archive\        <- empty folder (session archive)
  promptsystem-sync.json         <- sync config (if SYNCED)

[PRODUCT_REPO_FOLDER]\
  README.md                   <- from PRODUCT_REPO_README_TEMPLATE.md
  src\                        <- empty folder
  tests\                      <- empty folder
  docs\                       <- empty folder
  docs\ReleaseNotes\          <- empty folder (if release configured)
```

<!-- After generation, run integrity check (Procedure 4) to verify all required 
     files and constants are present. Report any gaps and fix from templates. -->

## Setup Schema

Flat registry of all setup fields from questionnaire sections 1-6. Used by Procedure 6 (Setup Analysis), Procedure 7 (Compare Workspace Setup), and Procedure 4 (Integrity Check, schema-aware mode). Fields are ordered by section number — conditions always reference earlier field IDs.

Condition syntax: `==` for equality, `AND` for conjunction, `(always)` for unconditional fields. No OR, no negation, no nested predicates.

Field types: `single` (string/path/name), `list` (array), `enum` (finite option set).

Status values for analysis: OK, GAP, STALE, DEVIATION, N/A.

### Section 1: Workspace Type and Mode

- id: workspace_type
  type: enum
  condition: (always)
  default: SOFTWARE-DEV
  report_label: Workspace Type
  options: [SOFTWARE-DEV, GENERAL]

- id: workspace_mode
  type: enum
  condition: workspace_type == SOFTWARE-DEV
  default: SINGLE-PROJECT
  report_label: Workspace Mode
  options: [SINGLE-PROJECT, MONOREPO, WORKSPACE]

### Section 2: Product Repo

- id: product_repo_folder
  type: single
  condition: workspace_mode == WORKSPACE
  default: myapp
  report_label: Product Repo Folder

- id: product_repo_description
  type: single
  condition: workspace_mode == WORKSPACE
  default: A CLI tool for ...
  report_label: Product Repo Description

- id: binary_build
  type: enum
  condition: workspace_mode == WORKSPACE
  default: no
  report_label: Binary Build
  options: [yes, no]

- id: binary_path_pattern
  type: single
  condition: workspace_mode == WORKSPACE AND binary_build == yes
  default: dist/[appname]-{version}-win-x64.exe
  report_label: Binary Path Pattern

### Section 3: Dev Repo / Workspace Root

- id: project_name
  type: single
  condition: (always)
  default: myapp
  report_label: Project Name

- id: project_goal
  type: single
  condition: (always)
  default: Describe what this project does
  report_label: Project Goal

- id: agent_folder_name
  type: single
  condition: (always)
  default: .devin (Devin) / .claude (Claude Code)
  report_label: Agent Folder Name

- id: sessions_folder_name
  type: single
  condition: (always)
  default: _sessions
  report_label: Sessions Folder Name

- id: sops_file_name
  type: single
  condition: (always)
  default: SOPS.md
  report_label: SOPS File Name

### Section 4: Version Strategy

- id: version_source
  type: enum
  condition: workspace_type == SOFTWARE-DEV
  default: promptsystem_folder
  report_label: Version Source
  options: [promptsystem_folder, pyproject_toml, package_json, none]

- id: tag_format
  type: enum
  condition: workspace_type == SOFTWARE-DEV
  default: date
  report_label: Tag Format
  options: [date, semver]

- id: post_release_bump
  type: enum
  condition: workspace_type == SOFTWARE-DEV
  default: promptsystem_rename
  report_label: Post-Release Bump Strategy
  options: [promptsystem_rename, patch_bump, minor_bump, none]

### Section 5: Sync Sources

- id: sync_relationship
  type: enum
  condition: workspace_mode == WORKSPACE
  default: SYNCED
  report_label: Sync Relationship
  options: [SYNCED, SELF-CONTAINED]

- id: promptsystem_source_path
  type: single
  condition: workspace_mode == WORKSPACE AND sync_relationship == SYNCED
  default: [WORKSPACE_FOLDER]\..\IPPS\PromptSystemV*
  report_label: PromptSystem Source Path

- id: company_folder_path
  type: single
  condition: workspace_mode == WORKSPACE AND sync_relationship == SYNCED
  default: [WORKSPACE_FOLDER]\..\Company
  report_label: Company Folder Path

- id: knowledge_folder
  type: single
  condition: workspace_mode == WORKSPACE
  default: [WORKSPACE_FOLDER]\knowledge
  report_label: Knowledge Folder

- id: specs_folder
  type: single
  condition: workspace_mode == WORKSPACE
  default: [WORKSPACE_FOLDER]\specs
  report_label: Specs Folder

- id: knowledge_include_patterns
  type: list
  condition: workspace_mode == WORKSPACE AND sync_relationship == SYNCED
  default: ["*"]
  report_label: Knowledge Include Patterns

- id: specs_include_patterns
  type: list
  condition: workspace_mode == WORKSPACE AND sync_relationship == SYNCED
  default: ["*"]
  report_label: Specs Include Patterns

- id: never_overwrite
  type: list
  condition: workspace_mode == WORKSPACE AND sync_relationship == SYNCED
  default: ["NOTES.md", "!NOTES.md", "PROBLEMS.md", "!PROGRESS.md", "FAILS.md", "ID-REGISTRY.md", "SOPS.md", "_SOPS.md", "promptsystem-sync.json"]
  report_label: Never Overwrite Patterns

### Section 6: Release Configuration

- id: github_releases
  type: enum
  condition: workspace_type == SOFTWARE-DEV
  default: yes
  report_label: GitHub Releases
  options: [yes, no]

- id: release_notes_directory
  type: single
  condition: workspace_type == SOFTWARE-DEV AND github_releases == yes
  default: [PRODUCT_DOCS_FOLDER]\ReleaseNotes
  report_label: Release Notes Directory

- id: run_tests_before_release
  type: enum
  condition: workspace_type == SOFTWARE-DEV
  default: yes
  report_label: Run Tests Before Release
  options: [yes, no]

- id: test_command
  type: single
  condition: workspace_type == SOFTWARE-DEV AND run_tests_before_release == yes
  default: from ## Build/Test Rules section in NOTES.md
  report_label: Test Command

- id: version_consistency_gate
  type: enum
  condition: workspace_type == SOFTWARE-DEV AND binary_build == yes
  default: yes
  report_label: Version Consistency Gate
  options: [yes, no]
