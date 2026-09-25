# ASCII Art Example: Charts

Demonstrates bar charts, sparklines, and proportion bars using Unicode block characters.

## Context

Charts encode quantity in monospace text. Every character is one unit. Block characters (`█ ▓ ▒ ░`) are fixed single-cell width, safe for all consumers. Values printed next to every bar or point - the bar shows proportion, the number carries the fact.

## Document

### Horizontal Bar Chart

```
[BAR CHART - REQUESTS PER ENDPOINT, LAST 24 H]

/api/search    ████████████████████████████████████████████  4,420  (44 %)
/api/items     ██████████████████████████                    2,610  (26 %)
/api/login     ██████████████                                1,380  (14 %)
/api/export    ████████                                        820  ( 8 %)
Other          ████████                                        790  ( 8 %)
                                                     Total  10,020

Scale: 1 █ = 100 requests
```

### Block Sparkline

```
[SPARKLINE - LATENCY p95, 40 BUCKETS OF 90 S]

▁▁▂▂▃▃▄▅▆▇███▇▆▅▄▄▅▆▇███▇▆▄▃▂▂▁▁▁▂▃▄▄▃▂▁
min 120 ms   max 980 ms   last 140 ms   summary = max per bucket
```

### Proportion Bar (Pie Replacement)

```
[PROPORTION - STORAGE BY FILE TYPE, 100 GB]

│██████████████████████▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒░░░░░░░░│
 0%                  40%                60%          80%      100%

Legend: █ PDF 40 GB (40 %)   ▓ Images 20 GB   ▒ Video 24 GB   ░ Other 16 GB
```

### Stacked Bar Chart (Multi-Color)

```
[BAR CHART - STORAGE BY TYPE AND TIER, GB]

/docs    ████████████████████▓▓▓▓▓▓▒▒▒░░  120  (hot 80  warm 24  cold 16)
/images  ████████████▓▓▓▓▒▒░░              72  (hot 48  warm 16  cold 8)
/video   ████▓▓▓▓▓▓▓▓▒▒▒▒▒▒░░░░          140  (hot 16  warm 32  cold 92)
/logs    ░░░░░░░░░░░░░░░░░░░░              48  (cold 48)

Legend: █ hot (SSD)   ▓ warm (HDD)   ▒ cold (tape)   ░ archive (glacier)
```

## Key Decisions

- Horizontal bars over vertical: labels stay readable, bar length = one char per unit
- Block characters (`█ ▓ ▒ ░`) chosen over ASCII (`# =`) for Unicode default per `core-conventions.md`
- Values printed next to every bar: the visual is supplementary, the number carries the fact
- Proportion bar replaces pie chart: angles cannot be drawn in text
- Sparkline uses 8-level block alphabet `▁▂▃▄▅▆▇█` for sub-cell resolution
