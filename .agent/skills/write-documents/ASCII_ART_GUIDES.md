# ASCII Art Diagram Guide

Read before creating or fixing ASCII art diagrams. Consumer: working agent (before), `/critique` (after). For post-execution verification rules, see companion `ASCII_ART_RULES.md`.

Writing quality: Apply `APAPALAN_RULES.md`. Key rules: AP-ST-01 (goal first), AP-PR-07 (be specific), AP-NM-01 (one name per concept).

## 1. Choose the Diagram Type

Pick the type from the question the reader must answer. Wrong type = unreadable diagram even with perfect alignment.

1. "What are the parts and how do they connect?" → Component diagram
2. "Which part sits on top of which?" → Layer diagram
3. "Where does each part run?" → Process topology
4. "Where does the data go?" → Data flow diagram
5. "Who calls whom, in what order?" → Sequence diagram
6. "What states exist and what moves between them?" → State machine
7. "What happens after this event?" → Event flow tree
8. "What are the stages of processing?" → Pipeline
9. "What depends on what?" → Dependency graph
10. "What does the screen look like?" → UX mockup
11. "How does the user move between screens?" → Screen flow
12. "What changes?" → BEFORE/AFTER
13. "How big / how much / how does it trend?" → Chart
14. "What contains what?" → Tree
15. "Which decision leads where?" → Flowchart
16. "Who does which step?" → Swimlane

Selection rules:
- Hierarchy without cycles = tree. Any cycle = state machine, never a tree
- Order matters = sequence or pipeline. Order does not matter = component diagram
- More than one actor = swimlane or sequence. One actor = flowchart
- A quantity = chart, never a diagram

## 2. Choose the Character Tier

Default: Tier 2 Unicode box-drawing (`─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`) per `core-conventions.md`.

1. Diagram lives in code comment, chat, or e-mail? → Tier 1 pure ASCII (`+ - |`)
2. Chart needs sub-cell resolution? → Tier 4 (braille or block eighths), line-pure only
3. Otherwise → Tier 2 light (default for all documents and all consumers)

Never mix tiers within one diagram. Never use `▼` (U+25BC); use `v` instead. Arrow `→` must have spaces: `A → B`.

## 3. Draw the Diagram

1. Set box positions and widths first, then route connectors
2. Use spaces only, never tabs
3. Keep verticals in one column on every row
4. Pad shorter labels so box interiors in one row have equal width
5. Min 1 space between text and `│` on both sides: `│ text │`, never `│text│`
6. 1-space gutter between nested boxes; 3-5 spaces between adjacent boxes
7. One concept per box, labels of 1-3 words
8. Label every node, region, and outcome explicitly
9. One dominant flow direction per diagram
10. 3-7 primary elements per diagram (max 6 for image generation)
11. Add title line, art block, legend line, and notes below the art

## 4. Route Connectors

After boxes are placed, route connectors between them. Connectors carry the diagram's flow information.

1. Use ASCII arrowheads inside grids: `>` `<` `^` `v` (not Unicode `→ ↓`)
2. Route connectors in the gutter between boxes, never through a box
3. Label connectors with one word on the line: `submit`, `publish`, `Yes`
4. Return paths: draw below the forward path, or omit and state in legend (`<-- response omitted`)
5. Sync vs async: solid line `──>` for sync, dashed `┄┄>` for async; state distinction in legend
6. Vertical connectors: compute center column of each box, attach line at that column
7. Branching connectors: use `┬` or `┴` at the junction, label each branch

## 5. Common Problems and Solutions

Frame glitch (broken corners, disconnected lines):
- Cause: mixed character tiers or misaligned junctions
- Fix: use one tier only; verify every corner uses matching glyphs (`┌ ┐ └ ┘`)

Mixed characters (`-` next to `─`, `|` next to `│`):
- Cause: copy-paste from different sources or tier confusion
- Fix: convert all line characters to one tier; run `SetAsciiBoxStyle.ps1` if available

Drifting verticals (connector shifts column between rows):
- Cause: miscounted columns or tab characters
- Fix: count columns, replace tabs with spaces, verify center column held on every row

Diagram too wide (wraps on mobile or in side panes):
- Cause: too many boxes in one row
- Fix: snake layout (wrap to next row), split into two diagrams, or group into named clusters

## 6. Example Lookup

Example files show complete GOOD diagrams for specific topics. Load when facing unfamiliar diagram types or complex layouts. Not mandatory for simple diagrams.

Wildcard pattern: `ASCII_ART_EXAMPLES_*.md`

Available example files:
- `ASCII_ART_EXAMPLES_CHARTS.md` - Bar charts, sparklines, proportion bars
- `ASCII_ART_EXAMPLES_UXDESIGN.md` - UI mockups, wireframes, modal dialogs
- `ASCII_ART_EXAMPLES_ARCHITECTURE.md` - System architecture, component diagrams, layer diagrams
- `ASCII_ART_EXAMPLES_STATEMACHINE.md` - State machines, flowcharts, decision trees

## Review Checklist

- [ ] Diagram type matches the question it answers
- [ ] One character tier used throughout
- [ ] No tabs, no trailing whitespace
- [ ] Every box has equal line width
- [ ] Verticals stay in one column
- [ ] Text does not touch frame (min 1 space padding)
- [ ] Labels are 1-3 words, one concept per box
- [ ] Width within limit (70 for Markdown, 120 for documents, 180 max)
- [ ] Title line, legend line, and notes present
- [ ] 3-7 primary elements, one flow direction
- [ ] Connectors routed in gutters, not through boxes
- [ ] Arrowheads are ASCII (`>` `<` `^` `v`) inside grids
- [ ] Connectors labeled with one word on the line
