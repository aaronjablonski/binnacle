# Mission Control: HUD v2, on a character grid

Date: 2026-11-15. Status: design only, nothing is built. It replaces `command-center-design.md` (HUD v1 and Telemetry).
Mocks: `Hud2*.dc.html` in `…/scratchpad/mcstyles/project/`, made by `…/scratchpad/gen-hud2.js`.
The generator places every piece of text at an absolute column and exits 1 when a row is too wide, starts off the grid, overruns its cell, or breaks the rhythm rules below. Screenshots of all 12 boards were checked against the overlay in `Hud2Grid`.

Why v1 looked misaligned: readouts were spaced by flex, and the bars were glyphs (`━ ─ ▁▂▃`) that the web font lacks, so a fallback font drew them narrower than one column. In v2 the mocks draw bars and sparklines as boxes of exactly n `ch`. In the terminal one glyph is one cell, so the build only has to count.

## Grid

One column is one character. A **cell** is 12 columns: 10 of content and 2 of gap.

| Columns | Use |
|---|---|
| 0 | gutter: `▍` headline, `┌` section, and the row flags `◂` (in view in the chat, which sits to the left) and `!` (problem here or below) |
| 1 | always blank |
| 2 | first cell; row glyph; section label |
| 4 | row name (6 and 8 for tree depth 1 and 2) |
| 6 / 14 | opened-row detail: dim key at 6, value at 14 (the second cell); the action line starts at 6 |
| 10 | a step's argument (tool name is 5 wide at 4) |
| 14, 26, 38, 50 | cells 2 to 5 |
| 38 | the one metric of a table row, at most 10 wide |
| 50 | time, at most 10 wide |
| 60, 61 | blank, except `5: Artifacts`, which is exactly 12 wide |

A name ends by column 36. Tabs, readouts, filter chips, the list/tree toggles and column heads all start on the five cell columns, so the tab `3: Agents`, the STEPS readout and a chip sit on one vertical line.

Widths (from `e.props.bodyColumns`, never `viewport`):

| bodyColumns | Tabs | Readout cells | Table |
|---|---|---|---|
| 62 and up | `1: Now` … `5: Artifacts`, 12-column cells | 5 | name, metric, time |
| 50 to 61 | `1: Now 2: Tsk 3: Agt 4: Stp 5: Art`, 7-column cells | 4 | name, time at the last cell |
| 38 to 49 | the same | 3 | name, time |
| 32 to 37 | `1: ◆ 2: ▣ 3: ◎ 4: ≡ 5: ↗`, 5-column cells | 2 | name only |
| under 32 | none: slim mode (below) | rows, not cells | name only |

General rule: cells = `min(5, floor((cols − 2) / 12))`; a dropped cell goes by priority (7D or 5H, then STEPS, then CTX). The inline strip at 96 columns uses eight of the same cells.

## Type, colour, spacing (theme keys only)

| Role | Drawing |
|---|---|
| Headline | bold, accent `▍` in the gutter; `next` dim at 2, its text at 8 |
| Section label | accent `┌` at 0, bold caps at 2, dim lower-case column heads at 38 and 50 |
| Readout | label dim caps, value bold, diagram 10 wide |
| Row | glyph at 2, name plain; metric and time dim. Done: dim `✓`, calm. Tasks done are dim throughout |
| Opened or focused row | bold name; the engine's own focus inverse (mock: a tinted row) |
| Structure and live | `suggestion`: `▍ ┌ ▸ ◂`, hotkeys, open tab, track, bar fill, find hits (underlined) |
| Waiting on you | `warning`: `?`, `▲`, the `┌ NEEDS YOU` corner and label, a rate bar at 70 % or more |
| Failure | `error`: `✖`, `!`, FAILED value, a rate bar at 90 % or more |
| Meta | `dimColor`; bar rest, tab track and tree guides `subtle` |
| Model share, artifact kinds | `merged` for model bars and docs, `success` for results only |

Diagrams, all exactly 10 columns: a bar (`━` fill, `─` rest; any non-zero value gets 1, only 100 % gets 10), a stacked bar for AGENTS (live, done, failed by largest remainder), and a 10-bucket sparkline for STEPS (steps per tenth of the session).

Rhythm: tab bar, track, one blank row. One blank row between sections and never two. Rows in a section are single-spaced. A list shows at most 6 rows, then `+ n more`. An opened row has a blank row above (unless it is first in its section) and below, 1 to 3 detail lines at column 6, and one action line. The footer holds at most 3 dim hints.

## Actions and keys

- The action line of an opened row is 2 or 3 plain hotkeyed Buttons in a row Box with `columnGap: 3`. The engine draws them `g: chat   k: keep   c: copy`; the mocks show that format, not an idealised one.
- The footer is at most 3 entries: hotkeyed plain Buttons with `dimColor` (so `n` and `p` really are armed), and engine keys as dim text (`↵ open`, `esc prompt`). It is drawn only while `e.props.isFocused`.
- Keys: `1`-`5` tabs. `n`/`p` next or previous error, hit or `!`. `f` find. `g` show in chat. `k` keep. `c` copy as Markdown, `q` quote (full step). `l`/`t`/`r` list, tree, running only. `s`/`v` steps, transcript. `d` all done tasks. `e` export. `x` dismiss.
- Commands, and nothing else: `/mc`, `/mc 1-5`, `/mc keep <note>`, `/mc export`, `/mc close`, `/mc slim`. No mock shows any other.

## Pin becomes Keep

"Pin" did not say what it does. The verb is now **Keep** (`k`, `/mc keep <note>`), the mark stays `★`, and the filter chip reads `Kept n`.
- Home: a `┌ KEPT` section on Now (the note as the name, the tool as the metric, the time). While it has under 3 rows it ends with one dim line: `kept steps are never trimmed and export in full`.
- On a step: the action reads `k: keep`; pressing it toasts `Kept: never trimmed, exported in full`. On a kept step it reads `k: unkeep`.
- On Artifacts, under `↥ Export digest`: `kept ★ steps go in with full input and result`.
- Behaviour is unchanged: default target is the latest main-conversation step; kept steps survive trimming, show under `Kept`, and are the only steps exported in full.

## Screens: default, and one press away

**Now.** Headline and `next`; `┌ NEEDS YOU` when anything waits (first row focused and opened: one `asks` line, `g: chat  x: dismiss  n: next`); five readouts TASKS, AGENTS, STEPS, CTX, 7D (5H replaces 7D when it is the hotter window); `┌ AGENTS` live only; `┌ LATEST` the running step and the newest error; `┌ KEPT`; `┌ NOTES` 2 lines. There is no header line: elapsed, live count, errors and budget are the readouts. One press: a row opens it on its tab; Enter on the readout row opens the budget view (every window, its reset time, per-model tokens) in place.

**Tasks.** Readouts DONE, ACTIVE, QUEUED (bars on one scale, the task total) and ELAPSED (completions sparkline). `┌ ACTIVE` one bold row with `2 live`; `┌ QUEUED` up to 5; `┌ DONE` newest 3 and `+ 6 more`. One press: the active task opens to its agents (one line each); `d` unfolds done.

**Agents, list.** Readouts LIVE, DONE, FAILED, then the two heaviest models (share of all tokens). A toggle row `l: List  t: Tree  r: Running` on the first three cells. `┌ AGENTS  tokens  time`: main, live, failed, then done; `+ n more done`. `┌ RUNS` one row per workflow run. One press: a row opens to `result` and `agent` (type, model, steps, start) with `s: steps  v: transcript  g: chat`; a run opens the run board.

**Agents, tree.** The same head. Guides in `subtle` at columns 2 and 4, names at 6 and 8, tokens and time on the same two columns. `!` in the gutter on a problem node and on every folded ancestor. Done children fold to `+ n done`. `r` hides everything but running branches.

**Steps.** Row 1: `f: Find` (or `/ query`), a count at 38, errors or the total at 50. Row 2: chips `All  Kept  Errors  In view`, one cell each, zero chips hidden. The newest turn under `┌ “prompt”  agent  time`, 5 rows then `+ n more in this turn`; `┌ EARLIER TURNS` one row per turn with step or hit count and start time. `◂` in the gutter marks rows in view. One press: a step opens in place: `status`, two `result` lines, `g: chat  k: keep  c: copy`. Second press (`↵ full step`): today's `detail.tsx` with Change, Result, Input and `c`, `q`, `b`.

**Artifacts.** `┌ ARTIFACTS  kind  age`, newest first, the focused one opened to `link` and `from` with `o: step  c: copy link  g: chat`. `┌ FILES CHANGED  edits  last`, 3 rows and `+ n more`. `┌ HANDOFF`: `↥ Export digest  journal  13:30`. One press: `e` exports (journal and clipboard).

**Band.** `▍ 9/14   focus   ▸ 2 live   ✖ 1 error   ctx 9%   7d 22%` and `/mc` at the right edge. Waiting: bold warning `▲ 2 need you` leads. Done: one dim row. It drops budget, then the words `live` and `error`, then `/mc`, then cuts the focus at a word. No hotkeys in the band.

**Inline strip (under 110 columns, `rows: 14`).** Tabs and track, then two halves on the same cells: left (cells 1 to 4) the headline, `next` and four readouts; right (cells 5 to 8) `┌ AGENTS` and `┌ LATEST` with metric at 74 and time at 86. 11 rows. Other tabs draw as docked and scroll.

## Slim mode

Applies whenever `bodyColumns` < 32. `/mc slim` asks the pane for 28 columns (`$.ui.open({ columns: 28 })`); `/mc slim` again restores 62. A dragged width still wins, and the layout only ever reads `bodyColumns`.

- **No tab bar.** A hotkeyed tab cannot be drawn narrower than `1: ◆`, and five of them need 24 columns plus the margin. Slim is one stacked summary; each `┌` label is a Button with a dim `›` in the last column, and Enter on it opens that tab's list in slim form (name-only rows, `b: back` on its first row). `/mc 1-5` still works from the prompt.
- **Grid.** Gutter at 0, content from 2, value column at 14 (the second cell), `›` at the last column. Budget rows use three stops: label 2, value 8, a 10-column bar at 14. From 24 up nothing moves; under 24 the bar shortens to `cols − 14` and the section value drops if it would touch `›`.
- **Order, top to bottom:** (1) focus, bold, wrapped by word to at most 2 lines; (2) `┌ NEEDS YOU n` in warning, the first item focused with `g: chat  x: dismiss`; (3) `┌ TASKS 9/14` and the current task, or the next one when the current task is the focus; (4) `┌ AGENTS 2 live` and up to 3 live names; (5) `┌ BUDGET` with CTX, 5H, 7D; (6) `┌ LATEST` with the newest error and the newest kept step.
- **Fitting.** A name is cut only at a word boundary and ends with `…`; a needs-you command wraps to a second line instead. If the stack is taller than `scroll.bodyRows`, whole sections drop from the bottom (LATEST, then BUDGET's 7D row, then the agent names). Nothing is cut mid-word and nothing wraps by accident: every Text gets `wrap: 'truncate-end'` as a backstop.
- **Footer:** `↵ open   esc prompt`.
- Tests: at 20, 24 and 28 columns no drawn row is wider than `bodyColumns`, no row ends inside a word, and the tree has no tab Buttons.

## Where each feature lives

- **Needs you:** `┌ NEEDS YOU` on Now and slim, the band lead, `!` in the gutter on Agents; `n`/`p`, `x`, `g`; `autoFocus` on the first row.
- **Find and jump:** `f` and the find row on Steps; hits underlined; `g: chat` on every opened row; `◂` in the gutter.
- **Budget:** CTX and 7D or 5H readouts on Now; model cells on Agents; tokens as the Agents metric; the budget view one press from the readouts; `┌ BUDGET` in slim.
- **Handoff:** `c: copy` on an opened step; `c` and `q` in the full step; `e` and `┌ HANDOFF` on Artifacts; `/mc export`.
- **Run board:** `┌ RUNS` on Agents, and the run as a branch in the tree.
- **Agent tree:** `t`; `!` on nodes and folded ancestors; `+ n done`; `r` running only.
- **Keyboard:** the key list above, the 3-entry footer, the trimmed `/mc` commands.

## Changes per view file (`mod/hooks/views/`)

- `style.ts`: `GRID = { margin: 2, cell: 12, content: 10 }`, `cellsFor(cols)`, `tier(cols)` (wide, mid, icon, slim). Colours as the table; `glyphColor('done')` dim.
- `fit.ts`: `at(col, text)` padding helper, `bar10`, `stack10`, `spark10`, `wordFit`, `wrapWords(text, cols, 2)`, `shortPaths`, `promptTitle`. Remove `blockBar`.
- `parts.tsx`: `section(label, metricHead, timeHead)`, `row({ flag, glyph, name, metric, time })` as one Button of padded strings and `Text`, `opened(details, actions)`, `readout(cells)` as Boxes of `width: 12`, `footer(hints)`, `more(n)`. Remove `sectionHeader` and its rule.
- `shell.tsx`: tab Buttons in `width: 12 | 7 | 5` Boxes, no `flexWrap`, no `│`; the track `Text`; no tab bar in slim; `/mc` argument parsing cut to `1-5`, `keep`, `export`, `close`, `slim`.
- `overview.tsx`: the Now order above; a new slim stack; two halves for the strip.
- `needs.tsx`: rows with `why` and `waiting`; the first one opened.
- `budget.tsx`: readout cells, the slim rows, and the opened budget view. `modelsSection` becomes the two model cells.
- `tasks.tsx`: readouts; ACTIVE, QUEUED, DONE with caps of 1, 5 and 3.
- `agents.tsx`, `agentmeta.ts`: three-column rows, the toggle row, `ui.agentOpen`, `+ n more done`, RUNS rows. Drop the `└` answer and `View` lines.
- `tree.tsx`: guides at 2 and 4, gutter `!`, shared columns, `+ n done`.
- `runboard.tsx`: the same row and opened parts.
- `timeline.tsx`, `find.ts`: find row and chips on cells; `Pinned` chip becomes `Kept`; 5 rows per turn; EARLIER TURNS rows; `ui.stepOpen`; gutter `◂`.
- `detail.tsx`, `openstep.ts`, `handoff.ts`: full step as the second press; `k` keep with the toast; export text says kept steps go in full.
- `artifacts.tsx`: three sections on the shared columns; the HANDOFF row and its note.
- `band.tsx`: the new parts and drop order.
- `guide.ts`: say "keep" where it says "pin".
- State: `UiState` gains `agentOpen?`, `stepOpen?`, `runningOnly`, `slim`; defaults wherever `ui` is restored.
- Tests: per view, assert start columns (metric at 38, time at 50, readout rows on cell columns, every diagram 10 wide) at 62, 40 and 32; one tab line at each tier; the slim tests above; no row over `bodyColumns` on any surface.

Buildability: no Box inside a Button, so a row's columns are padded strings inside one Button and the gutter flag is a sibling `Text` of width 2. Readout cells, tab cells and chips are fixed-width Boxes in a row with no gap. Hover adds nothing; focus uses the engine's inverse.

## Artboards

- `Hud2NowBusy`: Now, busy: headline, five readouts, AGENTS, LATEST, KEPT with its one-line explanation, NOTES.
- `Hud2NowWaiting`: Now with two things waiting: NEEDS YOU first, first row opened, 5H at 78 % in warning.
- `Hud2Tasks`: four readouts on one scale, ACTIVE, QUEUED, DONE folded.
- `Hud2Agents`: list: readouts, toggle row, six rows with one opened, RUNS.
- `Hud2AgentsTree`: tree: guides, gutter `!`, folded done counts, the same two metric columns.
- `Hud2Steps`: find `timeline`: counts, chips, underlined hits, earlier turns with hit counts.
- `Hud2StepOpen`: a failed step opened: three detail lines and `g: chat  k: keep  c: copy`.
- `Hud2Artifacts`: artifacts with one opened, files changed, handoff.
- `Hud2BandStrip`: band working, waiting, done and at 40; pane heads at 40 and 32; the 96-column strip.
- `Hud2Grid`: Now with every column, row and cell drawn, and a ruler.
- `Hud2Slim`: chat with a 24-column slim pane, busy.
- `Hud2SlimWaiting`: the same with NEEDS YOU on top.
