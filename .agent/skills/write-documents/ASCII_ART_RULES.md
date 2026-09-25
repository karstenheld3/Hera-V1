# ASCII Art Diagram Rules

Concrete verification rules with BAD/GOOD pairs. All rules checkable from output alone. Consumer: `/verify`.

## Rule Index

- AA-CH: Characters (tier compliance, forbidden glyphs)
- AA-MX: Mixed characters (no cross-tier mixing)
- AA-ST: Structure (box integrity, completeness)
- AA-AL: Alignment (columns, widths, padding)
- AA-WD: Width (limits per consumer)
- AA-AR: Arrows (spacing, forbidden forms)
- AA-LB: Labels (semantics, conciseness)
- AA-DI: Direction (one flow, consistent)

## AA-CH-01: Unicode Box-Drawing Default

All boxes in Markdown documents use Unicode box-drawing characters. ASCII `+ - |` for boxes only in code comments, chat, e-mail, or git diffs.

```
BAD:  +-------+    GOOD:  ┌───────┐
      | Box   |           │ Box   │
      +-------+           └───────┘
```

## AA-CH-02: No Forbidden Glyphs

Never use `▼` (U+25BC) or `▲` (U+25B2). Use `v` and `^` instead.

```
BAD:  v    GOOD:  v
     ▼          │
     │
```

## AA-MX-01: No Cross-Tier Mixing

Never mix ASCII line chars (`- | +`) with Unicode line chars (`─ │ ┌`) in one diagram. Joints do not connect and stroke weights differ.

```
BAD:  ┌───────┐    GOOD:  ┌───────┐
      | Box   |           │ Box   │
      └───────┘           └───────┘
```

## AA-MX-02: No Mixed Styles Within One Diagram

Never mix plain and rounded, normal and heavy, or normal and double in one diagram.

```
BAD:  ┌───────┐    GOOD:  ┌───────┐
      │ Box   │           │ Box   │
      ╚═══════╝           └───────┘
```

## AA-ST-01: Complete Box Frames

Every box has four corners and four edges. No missing corners, no disconnected lines.

```
BAD:  ┌───────    GOOD:  ┌───────┐
      │ Box   │           │ Box   │
      └───────┘           └───────┘
```

## AA-ST-02: Correct Junction Characters

T-junctions, crosses, and corners use the correct glyph for their position.

```
BAD:  ┌───────┬───────┐    GOOD:  ┌───────┬───────┐
      │ Box   ┼ Box   │           │ Box   │ Box   │
      └───────┴───────┘           └───────┴───────┘
```

## AA-ST-03: Tree Branch Characters

Tree branches use `├─>`, `└─>`, and `│` consistently. Never use `+--` or `|--` in a Unicode tree.

```
BAD:  ├──>    GOOD:  ├─>
      └──>           └─>
```

## AA-AL-01: Verticals in One Column

Vertical line characters stay in the same column on every row.

```
BAD:  ┌───────┐    GOOD:  ┌───────┐
      │ Box    │           │ Box   │
       └───────┘           └───────┘
```

## AA-AL-02: Equal Box Interior Width

Boxes in the same row have equal interior width. Pad shorter labels with spaces.

```
BAD:  ┌─────┐┌─────────┐    GOOD:  ┌───────┐┌─────────┐
      │ Box ││ Box Long│           │ Box   ││ Box Long│
      └─────┘└─────────┘           └───────┘└─────────┘
```

## AA-AL-03: Text Never Touches Frame

Min 1 space between text and `│` on both sides. Never `│text│`.

```
BAD:  │Box│    GOOD:  │ Box │
```

## AA-AL-04: Spaces Only, Never Tabs

No tab characters in diagrams. Tabs render as 2, 4, or 8 columns depending on viewer.

## AA-AL-05: No Trailing Whitespace

No trailing spaces on any line. Editors strip them and shift the art.

## AA-AL-06: Nested Box Gutter

Nested boxes have min 1-space gutter between outer and inner border on every side.

```
BAD:  │┌─────┐│    GOOD:  │ ┌─────┐ │
      ││ Box ││           │ │ Box │ │
      │└─────┘│           │ └─────┘ │
```

## AA-WD-01: Width Limits

Diagram width within consumer limit: 70 chars for Markdown/mobile, 120 for documents, 180 absolute max. Above 70, use snake layout or split into two diagrams.

```
BAD:  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐
      │ Module A │ │ Module B │ │ Module C │ │ Module D │ │ Mod E│
      └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────┘
      (exceeds 70 chars for Markdown)

GOOD: ┌──────────┐ ┌──────────┐ ┌──────────┐
      │ Module A │ │ Module B │ │ Module C │
      └──────────┘ └──────────┘ └──────────┘
      ┌──────────┐ ┌──────────┐
      │ Module D │ │ Module E │
      └──────────┘ └──────────┘
      (snake layout within limit)
```

## AA-AR-01: Arrow Spacing in Prose

Arrow `→` must have spaces around it in prose: `A → B`, never `A→B`.

```
BAD:  Request→Response    GOOD:  Request → Response
```

## AA-AR-02: No Unicode Arrows Inside Grid

Unicode arrows (`→ ← ↑ ↓`) have East-Asian ambiguous width. Use ASCII heads (`> < ^ v`) inside diagram grids.

```
BAD:  │ Box A │────→│ Box B │    GOOD:  │ Box A │────>│ Box B │
```

## AA-LB-01: One Concept Per Box

Each box contains one concept. Labels are 1-3 words. Multi-concept boxes force wide boxes.

```
BAD:  ┌─────────────────────────────┐
      │ Validate user input and auth │
      └─────────────────────────────┘

GOOD:  ┌──────────┐   ┌──────┐
       │ Validate │──>│ Auth │
       └──────────┘   └──────┘
```

## AA-LB-02: Every Node Labeled

Every node, region, and outcome has an explicit label. No unlabeled boxes.

```
BAD:  ┌───────┐     ┌───────┐    GOOD:  ┌───────┐     ┌───────┐
      │ Box A │────>│       │           │ Box A │────>│ Box B │
      └───────┘     └───────┘           └───────┘     └───────┘
```

## AA-LB-03: Kind Tags on Second Line

For LLM or image consumers, add kind tags on line 2 of boxes: `[SERVICE]`, `[DB]`, `[API]`.

```
BAD:  ┌───────────────┐    GOOD:  ┌───────────────┐
      │ Order Service │           │ Order Service │
      └───────────────┘           │ [API]         │
                                  └───────────────┘
```

## AA-DI-01: One Dominant Flow Direction

One dominant flow direction per diagram: left-to-right or top-to-bottom. Never mix primary directions in one diagram.

```
BAD:  ┌───────┐     ┌───────┐
      │ Box A │────>│ Box B │
      └───────┘     └───┬───┘
                        v
                    ┌───────┐
                    │ Box C │
                    └───────┘
      <─────┌───────┐
            │ Box D │
            └───────┘
      (mixed left-to-right, top-to-bottom, right-to-left)

GOOD: ┌───────┐     ┌───────┐     ┌───────┐
      │ Box A │────>│ Box B │────>│ Box C │
      └───────┘     └───────┘     └───────┘
      (one direction: left-to-right)
```

## AA-DI-02: Title and Legend Present

Every diagram has a title line above and a legend line below the art block.

```
BAD:  ┌───────┐     ┌───────┐
      │ Box A │────>│ Box B │
      └───────┘     └───────┘

GOOD: [COMPONENT DIAGRAM - SERVICE DEPENDENCIES]

      ┌───────┐     ┌───────┐
      │ Box A │────>│ Box B │
      └───────┘     └───────┘

      Legend: ────> synchronous call  [TYPE] = component kind
```

## AA-DI-03: 3-7 Primary Elements

Diagrams have 3-7 primary elements. Above 7, split into two diagrams or group into named clusters.
