# Mission Control: navigation pass

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal (Aaron, 2026-11-15):** "When I am on a tab and press down the caret lands at the first tab and then I have to traverse the whole UI. Down should always mean: go straight down in the tab that is active."

**When:** after Neo (N1–N5) lands, before the distilled features, because it touches `shell.tsx` and every view's first row.

## What the engine gives (type file, 2.1.325)

- `autoFocus` on one element: where the focus ring starts when the pane takes the keyboard (first drawn wins; a ring the person moved stays put).
- `ui.focus` fires **before** the ring moves (person's Tab, arrows or click; `autoFocus`; `$.ui.focus`). `next(e)` lands it on `e.element`; `next({ ...e, element })` redirects it to another of our elements; returning `{}` keeps it. Origin says `person` or `plugin`, **not which key**.
- So Down cannot be told apart from Tab or Right by the event alone. The design works from positions: we draw every focusable element, so we know the order and which ones are tabs.

## Design (decided; a spike confirms the engine's behaviour first)

1. **Focus starts in the content.** Every tab's first actionable row carries `autoFocus` (NEEDS YOU's first item when present, else the first row of the tab). Opening the pane (`/mc`, Ctrl+X Tab, a click) puts the ring there, never on `1: Now`.
2. **Keyboard traversal skips the tab bar.** A `ui.focus` hook (matched to our pane) redirects any person-origin move whose target is a tab Button to the nearest content row in the same direction (forward → first content row, backward → stays on the first content row). Tabs stay reachable by their hotkeys `1`–`5`, by click, and by `/mc 1-5`. A click on a tab still presses it (check in the spike; if a click is also a `ui.focus` with origin person, distinguish it by `ui.press` arriving right after, or let clicks through when the previous element is the same tab).
3. **Down walks rows top to bottom within the active tab;** deck rows that open something, section rows, `+ n more`, then the footer hints last. Order is the drawing order, so each view draws its focusables in reading order (audit and fix any view that does not).
4. **Switching tabs keeps you in content:** pressing `1`–`5` moves the ring to the new tab's `autoFocus` row (`$.ui.focus` from the press).
5. **Wrap:** Down on the last row stays (no jump back to the tab bar).

## Task

| Task | Scope | Model |
|---|---|---|
| V1 | Spike (one probe test in the kit + one real run): which keys raise `ui.focus`, whether a click on a tab raises it, what `e.element` is for the next stop. Then: `autoFocus` per view, the `ui.focus` redirect hook in `shell.tsx` (registered once, matched to the pane), focus-on-tab-switch, reading-order audit across views. | Opus |

Tests: opening the pane focuses the first content row (or the first NEEDS YOU item); a person move onto a tab Button is redirected to a content row; hotkey `3` switches tab and focuses that tab's first row; a click/press on a tab still switches; the hook returns what `next` resolved to and never throws; every view's focusables are in reading order.
