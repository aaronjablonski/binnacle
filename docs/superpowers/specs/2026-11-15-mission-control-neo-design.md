# Neo: the HUD with a crew (design round 5)

Date: 2026-11-15. Status: design only, nothing is built. It restyles HUD v2 (`hud2-design.md`); it does not replace its grid, keys, commands or features.
Mocks: `Neo*.dc.html` in `…/scratchpad/mcstyles/project/`, made by `…/scratchpad/gen-neo.js` (screenshots in `…/scratchpad/neo-preview/`).
The generator places every segment at an absolute column and exits 1 when a row is too wide, starts off the grid, crowds the next segment, breaks a bracket's rail, or breaks the row rhythm. All 12 boards pass and were checked as screenshots.
In the mocks every structural glyph (rails, corners, tethers, hulls, dials, bar segments, pips, sparks) is drawn as a CSS box of exactly 1 `ch`, so no fallback font can move a column. In the terminal each is one glyph in one cell.

The product name does not appear on any board.

## Identity

**Frame: twin brackets.** An instrument block (a "deck") is held by a heavy bracket on each side: `┏ ┃ ┗` in column 0 and `┓ ┃ ┛` in the last column. Corners take the accent, the rail between them is `subtle`. There is no top or bottom edge, so a deck costs no rows. A one-row band folds the bracket to its two rails (`┃ … ┃`). When something waits on you, the bracket turns `warning`. Tables keep HUD v2's light `┌ LABEL`.

**Label column.** Inside a deck the first cell (columns 2 to 11) holds one dim caps label per row: FOCUS, NEXT, CREW, TASKS, STEPS, BUDGET. The gauge starts at 14, the value at 38, an aside at 50: the same stops as a table's name, metric and time.

**Crew: pods.** One agent is one hull plus one signal cell. The hull's shape is the role, its fill is the state, its colour is the urgency.

| Role | From the agent type | Queued | Working | Done |
|---|---|---|---|---|
| lead | the main conversation, `Plan` and planners | `◇` | `◈` | `◆` |
| scout | `Explore`, search, research | `○` | `◉` | `●` |
| build | `general-purpose`, implementers, anything unknown | `□` | `▣` | `■` |
| check | review, test, verify | `△` | `◬` | `▲` |

- Queued: outline, dim. Working: lit core, bold accent (the lead in `claude`), pulsing bold and plain on the existing 1 s clock. Done: solid, dim.
- Waiting on you: lit core in `warning` with the signal `?`. Stalled: the same with `z`. Failed: outline in `error` with `!`.
- In a crew row pods sit at a pitch of 3 columns (hull, signal, gap); at most 7 in the pane (then 6 and `+n`), 12 in the band. In a one-row band they sit with no gaps.
- In a table the hull is the row glyph at column 2 and the signal is the gutter flag at column 0, which HUD v2 already has.
- A workflow run keeps `≡`. Steps keep `▸ ✓ ✖ ?`: a step is not a crew member.
- All twelve hulls are in Geometric Shapes (U+25A0 to U+25FF). Not checked against real terminal fonts; `◬` is the least common. `style.ts` should hold an ASCII set to fall back on (`<> () [] /\`, state by colour and signal) behind one constant.

**Gauges.**
- Dial, one cell: `○ ◔ ◑ ◕ ●` for 0, up to 25, up to 50, under 100, and 100 %. Written `CTX ◔ 9%`, at most 10 wide.
- Bar, 10 or 22 cells: `▮` lit, `▯` rest in `subtle`. Any non-zero value lights one cell; only 100 % lights all.
- Pips, one per task: `▪` done, `▸` current, `▫` queued. These are also the task row glyphs, so the gauge is its own legend. Over 22 tasks it becomes a 22-cell bar.
- Trace: HUD v2's sparkline, now 22 buckets in a deck (10 where a cell is all there is).
- Pill: a `Text` with `backgroundColor` and one space of padding each side: ` WORKING `, ` WAITING `, ` ALL DONE `, ` IDLE `, ` NEEDS YOU `, and the chosen filter chip.

**Palette (theme keys only).**

| Key | Use |
|---|---|
| `suggestion` | brackets, working hulls, the open tab and track, the current pip, bars and dials under 70 %, hotkeys, the WORKING pill |
| `claude` | the lead's hull while it works, and the kept `★` |
| `warning` | waiting and stalled hulls, `?` and `z`, the NEEDS YOU bracket and pill, a bar or dial from 70 % |
| `error` | failed hulls, `!`, `✖`, a bar or dial from 90 % |
| `merged` | model share bars, documents |
| `success` | result artifacts only |
| `subtle` | rails, tethers, a bar's rest, the tab track |
| `inverseText` | text on a pill |
| `dimColor` | labels, meta, done hulls |

## Grid and spacing

Unchanged from HUD v2: 62 columns, a gutter at 0, column 1 blank, 12-column cells at 2, 14, 26, 38, 50; names end by 36; metric at 38, time at 50; one blank row between blocks and never two; at most 6 rows in a section; an opened row has 1 to 3 detail lines and one action line.
New stops: the right bracket at the last column (61), so an aside ends by 59. Tree tethers take columns 2 to 3 (4 to 5 when two deep) and the hull follows at 4 (6).
Every tab now opens the same way: tab bar, track, one blank row, a deck of 2 to 7 rows, one blank row, then tables.

## Screens: what shows, and one press away

**Now.** Deck: FOCUS (bold, age at 50), NEXT, a blank rail row, CREW (pods, `2 live`, `1 failed`), TASKS (pips, `9/14`, elapsed), STEPS (trace, count, errors), BUDGET (three dials). Then `┌ AGENTS` live only, `┌ LATEST`, `┌ KEPT`, `┌ NOTES` as in v2. The deck replaces v2's headline, `next` and readout cells in 7 rows instead of 6.
One press: CREW opens Agents, TASKS opens Tasks, STEPS opens Steps, BUDGET opens the budget view in place.

**Now, waiting.** A `warning` bracket comes first: the ` NEEDS YOU ` pill, the count, `why` and `waiting` heads; the first item opened (`asks`, then `g: chat  x: dismiss  n: next`); the other items as rows. The deck follows; the crew shows who asks (`?`) and who stalled (`z`).

**Budget view.** A deck with `used` and `resets` heads and one row per window: CTX, 5H, 7D, each a 22-cell bar, the percentage, and the reset time (for CTX the token count). `┌ MODELS tokens share` and `┌ AGENTS tokens share` put a 10-cell bar in the time column. No dollar figure is drawn. `esc` goes back.

**Tasks.** Deck: TASKS (pips, done/total, elapsed) and PACE (completions trace, average, queued count). `┌ ACTIVE`: the task in bold with its agents tethered under it, one row each, tokens and time. `┌ QUEUED` with `▫`, `┌ DONE` with `▪`, newest 3 and `+ n more`. One press: a task opens or folds its agents; `d` unfolds done.

**Agents, list.** Deck: CREW (all pods: lead, live, failed, then done), ROLES (four cells: hull, role, count; the legend), MODELS (two models, each a value cell and a 10-cell bar). Toggle row `l: List  t: Tree  r: Running`. `┌ AGENTS tokens time` with hulls as glyphs and `!` in the gutter; the opened row adds the role to its `agent` line. `┌ RUNS` as v2.

**Agents, tree.** The same deck. Children hang from dashed tethers: `├╌◉ name`, `╰╌+ 3 done`, with `┆` as the outer guide when two deep. `!` in the gutter on a problem node and its folded ancestors. `r` keeps running branches only.

**Steps.** Deck: FIND (`f: type to search`, or `/ query` and the hit count; total at 38, errors at 50) and SHOW (the four filter chips on cells 2 to 5, the chosen one a pill). The turn tables, the `◂` in-view flag, the opened step and the second press to the full step with its diff are v2's.

**Artifacts.** Deck: HANDOFF (`↥ Export digest`, target, last export) and KEPT (how many kept steps go in full). `┌ ARTIFACTS` with one opened (`o: step  c: copy link  g: chat`), `┌ FILES CHANGED`. Result artifacts take `✦`, because `◆` is now a hull. `e` exports.

## Band

Three rows while the pane is closed and the band has 86 columns or more (9 cells at 110; budget cells drop from the right below that):
1. state pill at 2, focus (bold) at 14, age at 50, dials for CTX, 5H and 7D on the last three cells
2. `CREW`, pods at 14, `live`, `failed` and `done` counts from 50
3. `TASKS`, pips at 14, done/total at 38, `next` and the next task from 50, `/mc` on the last cell

Waiting: bracket and pill in `warning`; row 2 becomes `ASKS` (the first ask, why, how long, `+ n more`); row 3 is the crew.
All done: one dim row: ` ALL DONE `, totals, every hull solid.
Compact, one row: whenever the pane or the strip is open, or under 86 columns. Pill, focus, tight crew, done/total, the CTX dial, `/mc`. It drops the dial, then `/mc`, then cuts the focus.
The engine's own collapse (ctrl+x ctrl+a) hides the band entirely, so "collapsed" in the brief is drawn as this compact row, and nothing lives only in the band. No Buttons in the band.

## Slim and strip

**Slim (under 32 columns, 24 shown).** No tab bar, as v2. A left-only bracket holds the state pill and the focus (2 lines at most). Then `┌ CREW 2 live ›` with one row of pods and the live names, `┌ TASKS 9/14 ›` with the pips and the next task, `┌ BUDGET ›` with label 2, value 8, a 10-cell bar at 14, and `┌ LATEST`. Sections still drop from the bottom when the stack is too tall.

**Inline strip (under 110 columns, 14 rows).** Tabs and track, then the Now deck on cells 1 to 4 (six rows, no blank rail row, left bracket only) beside `┌ AGENTS` and `┌ LATEST` on cells 5 to 8 with metric at 74 and time at 86. 11 rows. The band under it stays compact.


## Changes against the HUD v2 views being built (`mod/hooks/views/`)

- `style.ts`: add `HULL` (role to three glyphs), `roleOf(agentType)`, `podOf(agent)` returning hull, colour, bold and signal; `C.spark = 'claude'`; `dialOf(pct)`; `RAIL` glyphs; the ASCII fallback set. `rateColor` is unchanged.
- `fit.ts`: `bar(value, total, cells)` returning `▮` and `▯` runs (replaces `bar10`'s `━ ─`); `pips(done, total, max)`; `spark(buckets, n)` for 10 or 22; `crewRow(pods, max)`; `meter(label, pct)`.
- `parts.tsx`: add `deck(rows)`: each row is a width-2 rail `Text`, a label, placed cells, and a right-rail `Text` at the last column; a row that opens something is one Button of padded strings and `Text`. Add `pill(word, color)` (a `Text` with `backgroundColor` and `inverseText`). `readout(cells)` goes once every view uses a deck. `row`, `section`, `opened`, `footer`, `more` are unchanged; `row` takes a tether prefix.
- `shell.tsx`: no change (tabs, track and tiers stay).
- `overview.tsx`: the Now deck in place of headline, `next` and readouts; the left-only deck in the strip; the slim head and its crew and pips rows.
- `needs.tsx`: the `warning` bracket and pill around v2's rows.
- `budget.tsx`: the BUDGET deck row of dials; the budget view as a deck plus MODELS and AGENTS tables with share bars.
- `tasks.tsx`: the TASKS and PACE deck; task glyphs `▸ ▫ ▪`; agents tethered under the active task.
- `agents.tsx`, `agentmeta.ts`: the CREW, ROLES, MODELS deck; `AGENT_GLYPH` replaced by `podOf`; the role in the opened row's `agent` line.
- `tree.tsx`: tethers `├╌ ╰╌` and `┆` in place of `├ │ └`; hulls as glyphs.
- `runboard.tsx`: hulls as glyphs; nothing else.
- `timeline.tsx`, `find.ts`: the FIND and SHOW deck in place of the find row and chip row; the chosen chip as a pill.
- `detail.tsx`, `openstep.ts`, `handoff.ts`: no change.
- `artifacts.tsx`: HANDOFF moves from a bottom section to the top deck with a KEPT row; result glyph `✦`.
- `band.tsx`: the three-row form, the compact form and the rule that picks one; the drop order above.
- Tests: each deck row starts on 2, 14, 26, 38 or 50 and its right rail on the last column; a bracket that opens also closes; every bar is exactly 10 or 22 wide; a crew row never passes column 36; `podOf` for each role and state; the band is one row while the pane is open.

Buildability: rails, hulls, signals, dials and pills are `Text`; a deck row is a row `Box` of fixed-width children, or one Button whose children are strings and `Text`. No Box sits inside a Button and every colour is a `ThemeKey`. Open points for the build: the narrow tiers (38 to 61 columns) are not mocked for decks (the rule would be: drop the aside, then the value); stalled detection must exist in the model for `z`; the mod must know the pane is open to pick the compact band.

## Artboards

- `NeoKit`: the identity on one sheet: the pod family by role and state, the gauges, the pills, the frame.
- `NeoBand`: the band working and waiting (three rows), all done, and compact at 84 and 48 columns.
- `NeoNowBusy`: Now, busy: the deck, then AGENTS, LATEST, KEPT, NOTES.
- `NeoNowWaiting`: Now with two things waiting: the warning bracket first, then the deck.
- `NeoBudget`: the budget view one press from the BUDGET row: windows, models, agents.
- `NeoTasks`: the TASKS and PACE deck; the active task with its agents tethered under it.
- `NeoAgents`: the CREW, ROLES, MODELS deck and the list with one agent opened.
- `NeoAgentsTree`: the same deck and the tethered tree with gutter flags.
- `NeoStepOpen`: the FIND and SHOW deck and a failed step opened in place.
- `NeoArtifacts`: the HANDOFF and KEPT deck, artifacts with one opened, files changed.
- `NeoSlim`: the slim sidebar at 24 columns.
- `NeoStrip`: the 14-row inline strip at 96 columns with the compact band under it.
