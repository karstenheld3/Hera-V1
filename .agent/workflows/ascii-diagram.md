---
description: Create or fix ASCII art diagrams in markdown documents
auto_execution_mode: 3
---

# ASCII Diagram Workflow

Create new ASCII art diagrams or fix existing ones in markdown documents.

**Goal**: Diagrams that are aligned, consistent, and compliant with Unicode box-drawing rules
**Why**: Prevents frame glitches, mixed character tiers, and broken layouts in rendered markdown

## Required Skills

- @skills:write-documents for ASCII art guides, rules, and helper scripts

## MUST-NOT-FORGET

- Read `ASCII_ART_GUIDES.md` before creating or fixing any diagram
- Use Unicode box-drawing characters per `core-conventions.md`: `├─>` `└─>` `│` `┌─` `├─` `└─` `│` `─` `┐` `┤` `┘`
- Never use `▼` (U+25BC); use `v` instead
- Arrow `→` must have spaces: `A → B` not `A→B`
- All content must be generic (no project-specific data) per Pre-Write Privacy Gate
- Do NOT load RULES or CHECKS files during execution. RULES are consumed by `/verify` post-execution. CHECKS are consumed by `/drift-detect` and `/improve`.

## Mode Detection

Detect mode from the user's verb:
- **Create mode**: "create", "add" → follow Create Steps below
- **Fix mode**: "fix", "change", "modify", "set" → follow Fix Steps below

## Create Steps

1. **Read Guides**
   - Read `ASCII_ART_GUIDES.md` from the write-documents skill

2. **Classify Diagram Type**
   - Identify the question the diagram answers (GUIDES section 1)
   - Select diagram type: tree, flow, layers, swimlane, state machine, UX mockup, chart, pipeline, component diagram
   - Selection rules:
     - Hierarchy without cycles = tree. Any cycle = state machine
     - Order matters = sequence or pipeline. Order does not matter = component diagram
     - More than one actor = swimlane or sequence. One actor = flowchart
     - A quantity = chart, never a diagram

3. **Choose Character Tier**
   - Default: Tier 2 Unicode box-drawing (`─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`)
   - Tier 1 pure ASCII (`+ - |`) only for code comments, chat, e-mail, git diffs
   - Tier 4 (braille, block eighths) only for chart sub-cell resolution, line-pure

4. **Decide: Load Example File?**
   - Example files are optional, not mandatory for simple diagrams
   - Wildcard pattern: `ASCII_ART_EXAMPLES_*.md` in the write-documents skill folder
   - Available examples:
     - `ASCII_ART_EXAMPLES_CHARTS.md` - Bar charts, sparklines, proportion bars
     - `ASCII_ART_EXAMPLES_UXDESIGN.md` - UI mockups, wireframes, modal dialogs
     - `ASCII_ART_EXAMPLES_ARCHITECTURE.md` - System architecture, component diagrams, layer diagrams
     - `ASCII_ART_EXAMPLES_STATEMACHINE.md` - State machines, flowcharts, decision trees
   - Load when facing unfamiliar diagram types or complex layouts

5. **Draw the Diagram**
   - Set box positions and widths first, then route connectors (GUIDES section 3-4)
   - Use spaces only, never tabs
   - Keep verticals in one column on every row
   - Route connectors in gutters between boxes, never through a box
   - Use ASCII arrowheads (`>` `<` `^` `v`) inside grids, not Unicode `→ ↓`
   - Label connectors with one word on the line
   - Pad shorter labels so box interiors in one row have equal width
   - Min 1 space between text and `│` on both sides: `│ text │`
   - 1-space gutter between nested boxes; 3-5 spaces between adjacent boxes
   - One concept per box, labels of 1-3 words
   - Label every node, region, and outcome explicitly
   - One dominant flow direction per diagram
   - 3-7 primary elements per diagram (max 6 for image generation)
   - Add title line, art block, legend line, and notes below the art

6. **Self-Verify**
   - Run the review checklist from GUIDES section "Review Checklist"
   - Verify alignment, character consistency, width limits
   - Insert diagram into target document

## Verification

Run `/verify` to check:
1. All rules from the RULES file pass (BAD/GOOD pairs checked against diagram)
2. Diagram type matches content
3. Character tier consistent throughout
4. Width within consumer limit

## Quality Gate

- [ ] GUIDES read before drawing
- [ ] One character tier used throughout
- [ ] No tabs, no trailing whitespace
- [ ] All boxes have complete frames
- [ ] Labels are 1-3 words, one concept per box
- [ ] Title and legend present
- [ ] Width within limit

## Fix Steps

1. **Read Guides**
   - Read `ASCII_ART_GUIDES.md` from the write-documents skill

2. **Identify Existing Diagram**
   - Locate the diagram in the file (line range)
   - Note the current style and character tier

3. **Detect Problem Type**
   - Frame glitch (broken corners, disconnected lines)
   - Mixed characters (`-` next to `─`, `|` next to `│`)
   - Wrong box style (plain vs unicode, normal vs rounded)
   - Drifting verticals (connector shifts column between rows)
   - Width overflow (exceeds consumer limit)

4. **Run Appropriate Script**
   - For style conversion: `SetAsciiBoxStyle.ps1`
     - Parameters: `-Path`, `-FirstLine`, `-LastLine`, `-TargetStyle`, `-DryRun`
     - Always run with `-DryRun` first to preview changes
     - Available styles: `plain-normal`, `plain-dotted`, `plain-dashed`, `plain-double`, `plain-rounded`, `unicode-normal`, `unicode-dotted`, `unicode-dashed`, `unicode-double`, `unicode-heavy`, `unicode-rounded`
   - For frame glitches: verify all corners use matching glyphs, fix manually
   - For drifting verticals: count columns, replace tabs with spaces, verify center column
   - For width overflow: snake layout, split into two diagrams, or group into named clusters

5. **Apply Fix**
   - Apply script output to the diagram (without `-DryRun` after preview is approved)
   - Manually fix any remaining issues

6. **Suggest Verification**
   - Suggest running `/verify` to check rule compliance
   - `/verify` checks all BAD/GOOD pairs against the diagram
