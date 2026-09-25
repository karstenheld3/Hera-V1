# ASCII Art Diagram Checks

Process discipline audit and quality improvement for ASCII art diagrams. Consumer: `/drift-detect` (PD), `/improve` (QI).

Evidence sources: target document containing diagram, session conversation, `ASCII_ART_GUIDES.md` read log.

## Process Discipline (PD)

### AA-PD-01: Read GUIDES Before Drawing

- Action: agent read `ASCII_ART_GUIDES.md` before creating or fixing a diagram
- Evidence: session conversation shows read directive before diagram creation
- Failure indicator: diagram created without referencing guides; agent drew from memory
- References: AA-ST-01, AA-CH-01

### AA-PD-02: Classified Diagram Type

- Action: agent identified the question the diagram answers and selected type from GUIDES section 1
- Evidence: session conversation states diagram type choice with rationale
- Failure indicator: diagram type does not match content (e.g., cycle drawn as tree, sequence drawn as component diagram)
- References: AA-DI-01, AA-DI-03

### AA-PD-03: Chose Character Tier

- Action: agent selected character tier per GUIDES section 2 (Tier 2 default, Tier 1 for ASCII-only, Tier 4 for charts)
- Evidence: diagram uses consistent tier throughout
- Failure indicator: mixed character tiers in one diagram (`-` next to `─`, `|` next to `│`)
- References: AA-CH-01, AA-MX-01

### AA-PD-04: Self-Verified Alignment

- Action: agent verified box widths, vertical column alignment, and text padding before inserting diagram
- Evidence: session conversation mentions self-verification or review checklist run
- Failure indicator: drifting verticals, unequal box widths, text touching frame
- References: AA-AL-01, AA-AL-02, AA-AL-03

### AA-PD-05: Verified Width Limit

- Action: agent checked diagram width against consumer limit (70 Markdown, 120 documents, 180 max)
- Evidence: diagram fits within stated width without wrapping
- Failure indicator: diagram wraps or exceeds 180 chars
- References: AA-WD-01

### AA-PD-06: Verified Arrow Formatting

- Action: agent used ASCII arrows (`>`, `v`) inside diagram grids and `→` with spaces in prose only
- Evidence: no Unicode arrows inside grid lines; `→` has spaces in all prose
- Failure indicator: `→` inside diagram grid causing CJK width shift; `▼` used instead of `v`
- References: AA-AR-01, AA-AR-02

### AA-PD-07: Evaluated Diagram Triggers

- Action: agent evaluated diagram auto-trigger conditions before finalizing document
- Evidence: document contains diagrams where trigger conditions apply (3+ components, layers, flows, or Q-branches)
- Failure indicator: 3+ components described in prose without any diagram
- References: SPEC-DG-08, INFO-FT-05, MINTO-AS-09

## Quality Improvement (QI)

### AA-QI-01: Is Diagram Type Optimal?

- Question: does the chosen diagram type best represent the content, or would another type communicate more clearly?
- Improvement tip: if a cycle is drawn as a tree, switch to state machine; if a linear process is nested boxes, switch to pipeline or flowchart

### AA-QI-02: Is Width Minimal?

- Question: could the diagram be narrower without losing information?
- Improvement tip: snake layout wraps long rows; group into named clusters; split into two diagrams if exceeding 7 elements

### AA-QI-03: Is Character Tier Appropriate?

- Question: is the tier choice correct for the consumer (human, LLM, image generator)?
- Improvement tip: Tier 1 for ASCII-only pipelines (code comments, e-mail); Tier 4 only for chart sub-cell resolution; Tier 2 for all other cases

### AA-QI-04: Could an Example Pattern Improve Output?

- Question: would loading an example file help match a proven pattern for this diagram type?
- Improvement tip: load `ASCII_ART_EXAMPLES_CHARTS.md` for bar charts or sparklines; `ASCII_ART_EXAMPLES_UXDESIGN.md` for UI mockups; `ASCII_ART_EXAMPLES_ARCHITECTURE.md` for component or layer diagrams; `ASCII_ART_EXAMPLES_STATEMACHINE.md` for state machines or flowcharts

### AA-QI-05: Are Labels Concise and Semantic?

- Question: are labels 1-3 words with one concept per box, or do sentence-length labels force wide boxes?
- Improvement tip: move detail to legend or notes below the art; use kind tags (`[SERVICE]`, `[DB]`) on line 2 of boxes for LLM or image consumers

### AA-QI-06: Is Depth Used Correctly?

- Question: if the diagram shows overlapping or stacked boxes, is the depth technique consistent and stated in the legend?
- Improvement tip: pick one depth technique (occlusion, offset stack, shadow, modal, isometric); state which border wins in the legend; do not mix isometric and flat boxes in one row
