# ASCII Art Example: UX Design

Demonstrates UI mockups, wireframes, and modal dialogs using Unicode box-drawing characters.

## Context

UX mockups are the source of truth for implementation. Show all buttons and interactive elements. Label text matches the implementation 1:1. One component per box. Overlays (toast, modal, dropdown) drawn as separate boxes below the main screen.

## Document

### Screen Wireframe (Desktop)

```
[SCREEN - JOBS OVERVIEW, DESKTOP 1280px]

┌─────────────────────────────────────────────────────────────────────────────┐
│  Logo   Jobs │ Sites │ Settings                      jane.smith  [Sign out] │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Streaming Jobs (2)                                                         │
│                                                                             │
│  [Start Job]  [Refresh]                              Toasts appear here ->  │
│                                                                             │
│  ┌────┬─────────┬──────────┬─────────┬────────────────────────────────────┐ │
│  │ ID │ Router  │ Endpoint │ State   │ Actions                            │ │
│  ├────┼─────────┼──────────┼─────────┼────────────────────────────────────┤ │
│  │ 42 │ crawler │ update   │ running │ [Monitor] [Pause / Resume] [Cancel]│ │
│  │ 41 │ crawler │ update   │ done    │ [Monitor]                          │ │
│  └────┴─────────┴──────────┴─────────┴────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Toast (separate component, bottom right, auto-dismiss 5 s):
┌───────────────────────────────────────────────┐
│  Job Started │ ID: 42 │ Total: 20 items   [x] │
└───────────────────────────────────────────────┘

Legend: [Text] = button with exact label   "Toasts appear here ->" = anchor, not visible text
```

### Modal Dialog

```
[MODAL - CONFIRM CANCEL JOB]

┌──────────────────────────────────────────────────────────────────────┐
│  Cancel job 42?                                                 [x]  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  The job has processed 7 of 20 items. Cancelling keeps the           │
│  7 finished items and discards the rest.                             │
│                                                                      │
│  [ ] Also delete the 7 finished items                                │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                        [Cancel job]        [Keep]    │
└──────────────────────────────────────────────────────────────────────┘

Legend: [Cancel job] = primary (destructive, red)   [Keep] = secondary
```

### Form

```
[FORM - CREATE SITE]

┌──────────────────────────────────────────────────────────────────────┐
│  New Site                                                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Site name *     [ Marketing intranet__________________ ]            │
│                                                                      │
│  URL *           [ https://________________________________ ]        │
│                  ! Must start with https://                          │
│                                                                      │
│  Crawl depth     [ 3          v]                                     │
│                                                                      │
│  Auth method     (o) API key     ( ) Managed identity                │
│                                                                      │
│  [x] Start first crawl immediately                                   │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                            [Create site]  [Cancel]   │
└──────────────────────────────────────────────────────────────────────┘

Legend: * = required   ! = inline validation message (red)   [Show] = toggles masking
```

## Key Decisions

- Rounded corners (`╭ ╮ ╰ ╯`) not used here: target UI has square corners, light set is default
- Overlays (toast) drawn as separate boxes below main screen, never nested inside it
- Modal footer: primary action LEFT, secondary RIGHT, both right-aligned
- Every `[Button]` in mockup matches spec's User Actions list 1:1
- 2-space padding inside boxes for UI mockups (whitespace is part of design)
